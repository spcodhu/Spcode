/**
 * QR payload 解析与 relay 通道工具的单测：
 * - relay+wss:// 前缀项的合法性校验与混排 hosts；
 * - channelId 推导与桌面端 deriveChannelId（node:crypto sha256 hex）一致；
 * - 连接顺序：LAN 直连优先，relay 殿后。
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateKeyPair } from "../src/lib/crypto";
import { parseQrPayload } from "../src/lib/qr";
import { deriveChannelId, isRelayHost, orderHosts, relayWsUrl } from "../src/lib/relay";
import { b64decode } from "../src/lib/base64";

function makeQr(hosts: string[], desktopPk: string, otp = "12345678"): string {
  return `spcode-remote://pair?v=1&hosts=${encodeURIComponent(hosts.join(","))}&desktop_pk=${encodeURIComponent(desktopPk)}&otp=${otp}`;
}

describe("parseQrPayload：relay 前缀项", () => {
  const pk = generateKeyPair().publicKey;

  it("接受 LAN 与 relay+wss:// 混排的 hosts，顺序保留", () => {
    const payload = parseQrPayload(makeQr(["http://192.168.1.5:8123", "relay+wss://relay.example.com"], pk));
    expect(payload.hosts).toEqual(["http://192.168.1.5:8123", "relay+wss://relay.example.com"]);
  });

  it("接受 relay+ws://（本地/测试 relay）", () => {
    const payload = parseQrPayload(makeQr(["relay+ws://127.0.0.1:8787"], pk));
    expect(payload.hosts).toEqual(["relay+ws://127.0.0.1:8787"]);
  });

  it("拒绝非 ws(s) 的 relay 项与未知 scheme", () => {
    expect(() => parseQrPayload(makeQr(["relay+http://x"], pk))).toThrow(/relay/);
    expect(() => parseQrPayload(makeQr(["ftp://x"], pk))).toThrow(/非法/);
  });
});

describe("relay 通道工具", () => {
  it("channelId = SHA-256(桌面公钥原始 32 字节) 的 hex 小写（与桌面端一致）", () => {
    const pk = generateKeyPair().publicKey;
    const expected = createHash("sha256").update(Buffer.from(b64decode(pk))).digest("hex");
    expect(deriveChannelId(pk)).toBe(expected);
    expect(deriveChannelId(pk)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("relayWsUrl：/channel/<channelId>?role=device", () => {
    const pk = generateKeyPair().publicKey;
    const url = relayWsUrl("relay+wss://relay.example.com/", pk);
    expect(url).toBe(`wss://relay.example.com/channel/${deriveChannelId(pk)}?role=device`);
  });

  it("isRelayHost / orderHosts：LAN 直连优先，relay 殿后且组内顺序不变", () => {
    expect(isRelayHost("relay+wss://r")).toBe(true);
    expect(isRelayHost("http://a")).toBe(false);
    expect(orderHosts(["relay+wss://r1", "http://a", "relay+wss://r2", "http://b"])).toEqual([
      "http://a",
      "http://b",
      "relay+wss://r1",
      "relay+wss://r2",
    ]);
  });
});
