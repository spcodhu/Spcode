import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
