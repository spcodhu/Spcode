import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "@spcode/shared";
import { OFFICIAL_MOBILE_URL, OFFICIAL_RELAY_URL, resolveRelayConfig } from "@spcode/shared/remote";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayTransport, testRelayConnection } from "../src/main/remote/transport/relay.js";
import { SettingsStore } from "../src/main/settings-store.js";

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
  const server = createServer();
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
  it("无密钥查健康端点；有密钥真实签发票据且不泄露密钥到 URL", async () => {
    const health = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(
      await testRelayConnection({ url: "wss://relay.example.com", channelId: "a".repeat(64), fetchImpl: health }),
    ).toEqual({ ok: true });
    expect(String(health.mock.calls[0]?.[0])).toBe("https://relay.example.com/health");

    const ticket = vi.fn(async () => new Response(JSON.stringify({ ticket: "one-time" }), { status: 200 }));
    expect(
      await testRelayConnection({
        url: "wss://relay.example.com",
        channelId: "a".repeat(64),
        accessKey: "secret",
        fetchImpl: ticket,
      }),
    ).toEqual({ ok: true });
    const [url, init] = ticket.mock.calls[0]!;
    expect(String(url)).toBe("https://relay.example.com/v1/tickets");
    expect(String(url)).not.toContain("secret");
    expect(init?.headers).toMatchObject({ authorization: "Bearer secret" });
  });

  it("401 返回错误并进入 auth_failed，不做无意义重连", async () => {
    const unauthorized = vi.fn(async () => new Response(null, { status: 401 }));
    expect(
      await testRelayConnection({
        url: "wss://relay.example.com",
        channelId: "a".repeat(64),
        accessKey: "bad",
        fetchImpl: unauthorized,
      }),
    ).toEqual({ ok: false, error: "relay_http_401" });
    unauthorized.mockClear();
    const transport = new RelayTransport({
      url: "ws://127.0.0.1:8787",
      channelId: "a".repeat(64),
      accessKey: "bad",
      fetchImpl: unauthorized,
    });
    await transport.start();
    await vi.waitFor(() => expect(transport.getState()).toBe("auth_failed"));
    expect(unauthorized).toHaveBeenCalledTimes(1);
    await transport.stop();
  });

  it.each([401, 403])("匿名 WS 握手 %i 进入 auth_failed 且不再重连", async (status) => {
    const relay = await startRejectingRelay(status);
    const logs: { message: string; extra?: unknown }[] = [];
    const transport = new RelayTransport({
      url: relay.url,
      channelId: "a".repeat(64),
      reconnectInitialMs: 10,
      reconnectMaxMs: 20,
      log: (message, extra) => logs.push({ message, extra }),
    });
    try {
      await transport.start();
      await vi.waitFor(() => expect(transport.getState()).toBe("auth_failed"));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(relay.attempts()).toBe(1);
      expect(logs).toContainEqual({
        message: "relay 连接失败",
        extra: { status, authFailed: true, anonymous: true },
      });
      expect(logs.some((entry) => entry.message === "relay 断线，等待重连")).toBe(false);
    } finally {
      await transport.stop();
      await relay.close();
    }
  });

  it("非认证 WS 握手错误仍按退避策略重连", async () => {
    const relay = await startRejectingRelay(500);
    const transport = new RelayTransport({
      url: relay.url,
      channelId: "a".repeat(64),
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
});
