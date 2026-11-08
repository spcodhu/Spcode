import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "@spcode/shared";
import { deriveChannelId, generateBoxKeyPair, verifyHostProof } from "@spcode/shared/crypto";
import { OFFICIAL_MOBILE_URL, OFFICIAL_RELAY_URL, resolveRelayConfig } from "@spcode/shared/remote";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayTransport, testRelayConnection } from "../src/main/remote/transport/relay.js";
import { SettingsStore } from "../src/main/settings-store.js";

const relayIdentity = generateBoxKeyPair();
const desktop = generateBoxKeyPair();
const channelId = deriveChannelId(desktop.publicKey);
const identity = () => desktop;

/** 假 relay HTTP：relay-info 固定返回 relayIdentity；tickets 按 ticketStatus 响应 */
function fakeFetch(ticketStatus = 200, infoStatus = 200) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/relay-info")) {
      return new Response(JSON.stringify({ version: 3, relayPk: relayIdentity.publicKey }), { status: infoStatus });
    }
    if (url.endsWith("/v1/tickets")) {
      if (ticketStatus !== 200) return new Response(null, { status: ticketStatus });
      const body = JSON.parse(String(init?.body)) as { channelId: string; ts: number; proof: string; hostPk: string };
      const ok =
        deriveChannelId(body.hostPk) === body.channelId &&
        verifyHostProof(body.channelId, body.ts, body.proof, body.hostPk, relayIdentity.secretKey);
      return new Response(JSON.stringify(ok ? { ticket: "one-time" } : { error: "proof_invalid" }), {
        status: ok ? 200 : 401,
      });
    }
    return new Response(null, { status: 404 });
  });
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function settingsHome(remote: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "spcode-relay-settings-"));
  dirs.push(dir);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ remote }));
  return dir;
}

/** 用真实 HTTP Upgrade 拒绝复现 ws 的 unexpected-response 分支。 */
async function startRejectingRelay(status: number) {
  let attempts = 0;
  const server = createServer((req, res) => {
    if (req.url === "/v1/relay-info") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: 3, relayPk: relayIdentity.publicKey }));
      return;
    }
    if (req.url === "/v1/tickets") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ticket: "t" }));
      return;
    }
    res.writeHead(404).end();
  });
  server.on("upgrade", (_request, socket) => {
    attempts++;
    socket.end(
      `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Error"}\r\n\r\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    attempts: () => attempts,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("relay 配置迁移", () => {
  it("官方 relay 与手机端入口使用当前官方域名", () => {
    expect(OFFICIAL_RELAY_URL).toBe("wss://spcod-relay.hlt.cab");
    expect(OFFICIAL_MOBILE_URL).toBe("https://spcod-relay.hlt.cab/");
  });

  it("新安装默认官方 relay；旧自定义地址保留 custom，旧 null 保持 LAN-only", () => {
    expect(DEFAULT_SETTINGS.remote.relayMode).toBe("official");
    expect(resolveRelayConfig(DEFAULT_SETTINGS.remote).url).toBe(OFFICIAL_RELAY_URL);
    const custom = new SettingsStore(settingsHome({ relayUrl: "wss://relay.example.com" }));
    expect(custom.get().remote.relayMode).toBe("custom");
    const lan = new SettingsStore(settingsHome({ relayUrl: null }));
    expect(lan.get().remote.relayMode).toBe("disabled");
  });
});

describe("relay 测试连接与错误状态", () => {
  it("测试连接 = relay-info + 真实 host 证明取票；访问密钥叠加为 Bearer 且不进 URL", async () => {
    const open = fakeFetch();
    expect(await testRelayConnection({ url: "wss://relay.example.com", channelId, identity, fetchImpl: open })).toEqual(
      {
        ok: true,
      },
    );
    expect(String(open.mock.calls[0]?.[0])).toBe("https://relay.example.com/v1/relay-info");
    const [ticketUrl, ticketInit] = open.mock.calls[1]!;
    expect(String(ticketUrl)).toBe("https://relay.example.com/v1/tickets");
    const body = JSON.parse(String(ticketInit?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ channelId, role: "host", hostPk: desktop.publicKey });
    expect(typeof body.ts).toBe("number");
    expect(typeof body.proof).toBe("string");
    expect(ticketInit?.headers).not.toHaveProperty("authorization");

    const keyed = fakeFetch();
    expect(
      await testRelayConnection({
        url: "wss://relay.example.com",
        channelId,
        identity,
        accessKey: "secret",
        fetchImpl: keyed,
      }),
    ).toEqual({ ok: true });
    const [url, init] = keyed.mock.calls[1]!;
    expect(String(url)).not.toContain("secret");
    expect(init?.headers).toMatchObject({ authorization: "Bearer secret" });
  });

  it("别的桌面身份拿不到本 channel 的票据（证明与 channelId 不匹配）", async () => {
    const stranger = generateBoxKeyPair();
    expect(
      await testRelayConnection({
        url: "wss://relay.example.com",
        channelId,
        identity: () => stranger,
        fetchImpl: fakeFetch(),
      }),
    ).toEqual({ ok: false, error: "relay_http_401" });
  });

  it("取票 401 → auth_failed，按长间隔重试并重拉 relay-info（relay 换钥可自愈）", async () => {
    const unauthorized = fakeFetch(401);
    expect(
      await testRelayConnection({ url: "wss://relay.example.com", channelId, identity, fetchImpl: unauthorized }),
    ).toEqual({ ok: false, error: "relay_http_401" });
    unauthorized.mockClear();
    const logs: { message: string; extra?: unknown }[] = [];
    const transport = new RelayTransport({
      url: "ws://127.0.0.1:8787",
      channelId,
      identity,
      fetchImpl: unauthorized,
      reconnectInitialMs: 10,
      reconnectMaxMs: 20,
      log: (message, extra) => logs.push({ message, extra }),
    });
    await transport.start();
    await vi.waitFor(() => expect(transport.getState()).toBe("auth_failed"));
    // relay-info + tickets 各一次；auth_failed 不走 10ms 快速退避
    expect(unauthorized).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(unauthorized).toHaveBeenCalledTimes(2);
    expect(logs).toContainEqual({ message: "relay 断线，等待重连", extra: { delayMs: 60_000 } });
    await transport.stop();
  });

  it.each([401, 403])("WS 握手 %i 进入 auth_failed 且不走快速重连", async (status) => {
    const relay = await startRejectingRelay(status);
    const logs: { message: string; extra?: unknown }[] = [];
    const transport = new RelayTransport({
      url: relay.url,
      channelId,
      identity,
      reconnectInitialMs: 10,
      reconnectMaxMs: 20,
      log: (message, extra) => logs.push({ message, extra }),
    });
    try {
      await transport.start();
      await vi.waitFor(() => expect(transport.getState()).toBe("auth_failed"));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(relay.attempts()).toBe(1);
      expect(logs).toContainEqual({ message: "relay 连接失败", extra: { status, authFailed: true } });
    } finally {
      await transport.stop();
      await relay.close();
    }
  });

  it("非认证 WS 握手错误仍按退避策略重连", async () => {
    const relay = await startRejectingRelay(500);
    const transport = new RelayTransport({
      url: relay.url,
      channelId,
      identity,
      reconnectInitialMs: 10,
      reconnectMaxMs: 20,
    });
    try {
      await transport.start();
      await vi.waitFor(() => expect(relay.attempts()).toBeGreaterThan(1));
    } finally {
      await transport.stop();
      await relay.close();
    }
  });

  it("relayPk 未知时不广告 relay 地址、不签发设备令牌；拿到后两者可用", async () => {
    const broken = fakeFetch(200, 500);
    const transport = new RelayTransport({
      url: "ws://127.0.0.1:8787",
      channelId,
      identity,
      fetchImpl: broken,
      reconnectInitialMs: 10,
      reconnectMaxMs: 20,
    });
    await transport.start();
    await vi.waitFor(() => expect(transport.getState()).toBe("error"));
    expect(transport.getAdvertisedUrls()).toEqual([]);
    expect(transport.issueDeviceGrant("phone", Date.now() + 1000)).toBeNull();
    await transport.stop();

    const relay = await startRejectingRelay(500);
    const live = new RelayTransport({
      url: relay.url,
      channelId,
      identity,
      reconnectInitialMs: 10,
      reconnectMaxMs: 20,
    });
    try {
      await live.start();
      await vi.waitFor(() => expect(live.getAdvertisedUrls()).toEqual([`relay+${relay.url}`]));
      const grant = live.issueDeviceGrant("phone", Date.now() + 1000);
      expect(grant).not.toBeNull();
    } finally {
      await live.stop();
      await relay.close();
    }
  });
});
