import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DEFAULT_SETTINGS, SECRET_MASK } from "@spcode/shared";
import {
  buildChromiumProxyRule,
  buildNetworkProxyUrl,
  DEFAULT_NETWORK_PROXY_SETTINGS,
  isNetworkProxyConfigured,
  sanitizeNetworkProxySettings,
} from "@spcode/shared/proxy";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { RelayTransport } from "../src/main/remote/transport/relay.js";
import { redactSettingsForRenderer, restoreMaskedSecrets, SettingsStore } from "../src/main/settings-store.js";
import { applyNetworkProxyEnvironment, configureNetworkProxy, createNodeProxyAgent } from "../src/network-proxy.js";

const servers = new Set<http.Server>();

afterEach(async () => {
  configureNetworkProxy(DEFAULT_NETWORK_PROXY_SETTINGS);
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear();
});

async function listen(server: http.Server): Promise<number> {
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("代理配置与 URL", () => {
  it("清洗字段、验证地址，并正确编码认证信息", () => {
    const config = sanitizeNetworkProxySettings({
      enabled: true,
      protocol: "https",
      host: " proxy.example.com ",
      port: 8443,
      username: "user@example.com",
      password: "p@ss:/?#",
    });
    expect(isNetworkProxyConfigured(config)).toBe(true);
    const proxyUrl = buildNetworkProxyUrl(config)!;
    const parsed = new URL(proxyUrl);
    expect(parsed.protocol).toBe("https:");
    expect(parsed.hostname).toBe("proxy.example.com");
    expect(parsed.port).toBe("8443");
    expect(decodeURIComponent(parsed.username)).toBe("user@example.com");
    expect(decodeURIComponent(parsed.password)).toBe("p@ss:/?#");
    const chromium = new URL(buildChromiumProxyRule(config)!);
    expect(chromium.username).toBe("");
    expect(chromium.password).toBe("");
  });

  it("无效端口/地址不会启用代理；IPv6 自动加方括号", () => {
    expect(sanitizeNetworkProxySettings({ port: 70000 }).port).toBe(8080);
    expect(
      buildNetworkProxyUrl({ ...DEFAULT_NETWORK_PROXY_SETTINGS, enabled: true, host: "http://proxy.example.com" }),
    ).toBeNull();
    expect(
      buildNetworkProxyUrl({ ...DEFAULT_NETWORK_PROXY_SETTINGS, enabled: true, host: "proxy.example.com:8080" }),
    ).toBeNull();
    expect(buildNetworkProxyUrl({ ...DEFAULT_NETWORK_PROXY_SETTINGS, enabled: true, host: ":::" })).toBeNull();
    expect(buildNetworkProxyUrl({ ...DEFAULT_NETWORK_PROXY_SETTINGS, enabled: true, host: "::1", port: 1080 })).toBe(
      "http://[::1]:1080/",
    );
  });
});

describe("代理密码存储", () => {
  it("渲染层只见掩码，写回掩码保留真值，磁盘仍存真实密码", () => {
    const dir = mkdtempSync(join(tmpdir(), "spcode-proxy-settings-"));
    try {
      const store = new SettingsStore(dir);
      store.set({
        proxy: { enabled: true, protocol: "http", host: "127.0.0.1", port: 8080, username: "u", password: "secret" },
      });
      const redacted = redactSettingsForRenderer(store.get());
      expect(redacted.proxy.password).toBe(SECRET_MASK);
      const restored = restoreMaskedSecrets({ proxy: redacted.proxy }, store.get());
      expect(restored.proxy?.password).toBe("secret");
      const disk = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as typeof DEFAULT_SETTINGS;
      expect(disk.proxy.password).toBe("secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Node 网络栈真实代理转发", () => {
  it("global fetch 经 HTTP 代理并携带 Basic 认证，关闭后恢复环境", async () => {
    const requests: { url?: string; authorization?: string }[] = [];
    const proxy = http.createServer((req, res) => {
      requests.push({ url: req.url, authorization: req.headers["proxy-authorization"] });
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ ok: true }));
    });
    const port = await listen(proxy);
    const baseline = process.env.HTTP_PROXY;
    configureNetworkProxy({
      enabled: true,
      protocol: "http",
      host: "127.0.0.1",
      port,
      username: "user",
      password: "p@ss",
    });

    // 不存在的目标域名也不会发 DNS/直连：代理由本地假服务器终止并直接响应。
    const response = await fetch("http://proxy-target.invalid/path?q=1");
    expect(await response.json()).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://proxy-target.invalid/path?q=1");
    expect(requests[0]?.authorization).toBe(`Basic ${Buffer.from("user:p@ss").toString("base64")}`);
    expect(process.env.HTTPS_PROXY).toContain(`127.0.0.1:${port}`);

    const childEnv = applyNetworkProxyEnvironment({ PATH: "/bin", HTTP_PROXY: "http://stale" });
    expect(childEnv.HTTPS_PROXY).toBe(process.env.HTTPS_PROXY);
    configureNetworkProxy(DEFAULT_NETWORK_PROXY_SETTINGS);
    expect(process.env.HTTP_PROXY).toBe(baseline);
    expect(applyNetworkProxyEnvironment({ HTTP_PROXY: "http://stale" }).HTTP_PROXY).toBe(baseline);
  });

  it("relay WebSocket 经 HTTP CONNECT 隧道，代理认证不会退化成直连", async () => {
    const target = http.createServer();
    const wss = new WebSocketServer({ server: target });
    wss.on("connection", (ws) => ws.send(JSON.stringify({ t: "relay.hello", role: "host", queued: 0 })));
    const targetPort = await listen(target);
    const connects: { url?: string; authorization?: string }[] = [];
    const proxy = http.createServer();
    proxy.on("connect", (req, client, head) => {
      connects.push({ url: req.url, authorization: req.headers["proxy-authorization"] });
      const upstream = net.connect(targetPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    const proxyPort = await listen(proxy);
    const transport = new RelayTransport({
      url: `ws://127.0.0.1:${targetPort}`,
      channelId: "a".repeat(64),
      proxy: {
        enabled: true,
        protocol: "http",
        host: "127.0.0.1",
        port: proxyPort,
        username: "relay",
        password: "secret",
      },
      reconnectInitialMs: 20,
    });
    try {
      await transport.start();
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000;
        const poll = () => {
          if (transport.getState() === "connected") return resolve();
          if (Date.now() > deadline) return reject(new Error("relay 未在超时前经代理连接"));
          setTimeout(poll, 10);
        };
        poll();
      });
      expect(connects[0]?.url).toBe(`127.0.0.1:${targetPort}`);
      expect(connects[0]?.authorization).toBe(`Basic ${Buffer.from("relay:secret").toString("base64")}`);
      expect(createNodeProxyAgent()).toBeUndefined();
    } finally {
      await transport.stop();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});
