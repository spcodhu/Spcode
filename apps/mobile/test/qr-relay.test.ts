/**
 * QR payload 解析与 relay 通道工具的单测：
 * - relay+wss:// 前缀项的合法性校验与混排 hosts；
 * - channelId 推导与桌面端 deriveChannelId（node:crypto sha256 hex）一致；
 * - 连接顺序：LAN 直连优先，relay 殿后。
 */

import { createHash } from "node:crypto";
import { b64decode, generateBoxKeyPair } from "@spcode/shared/crypto";
import { describe, expect, it, vi } from "vitest";
import { parseQrPayload } from "../src/lib/qr";
import { deriveChannelId, isRelayHost, orderHosts, probeRelay, relayTicketQuery, relayWsUrl } from "../src/lib/relay";

function makeQr(hosts: string[], desktopPk: string, otp = "12345678"): string {
  return `spcode-remote://pair?v=2&hosts=${encodeURIComponent(hosts.join(","))}&desktop_pk=${encodeURIComponent(desktopPk)}&otp=${otp}`;
}

describe("parseQrPayload：relay 前缀项", () => {
  const pk = generateBoxKeyPair().publicKey;

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

  it("QR v3 携带自托管访问密钥，v2 保持兼容", () => {
    const payload = parseQrPayload(
      `spcode-remote://pair?v=3&hosts=${encodeURIComponent("relay+wss://relay.example.com")}&desktop_pk=${encodeURIComponent(pk)}&otp=12345678&relay_key=server-secret`,
    );
    expect(payload.version).toBe(3);
    expect(payload.relayAccessKey).toBe("server-secret");
    expect(parseQrPayload(makeQr(["relay+wss://relay.example.com"], pk)).relayAccessKey).toBeUndefined();
  });
});

describe("relay 通道工具", () => {
  it("channelId = SHA-256(桌面公钥原始 32 字节) 的 hex 小写（与桌面端一致）", () => {
    const pk = generateBoxKeyPair().publicKey;
    const expected = createHash("sha256")
      .update(Buffer.from(b64decode(pk)))
      .digest("hex");
    expect(deriveChannelId(pk)).toBe(expected);
    expect(deriveChannelId(pk)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("relayWsUrl：/channel/<channelId>?role=device", () => {
    const pk = generateBoxKeyPair().publicKey;
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

  it("访问密钥换取单次 ticket 并绑定 device；401 映射认证失败", async () => {
    const pk = generateBoxKeyPair().publicKey;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ticket: "one-time" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const query = await relayTicketQuery("relay+wss://relay.example.com", pk, "device", "phone", "secret");
    expect(query).toBe("&ticket=one-time");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://relay.example.com/v1/tickets");
    expect(init?.headers).toMatchObject({ authorization: "Bearer secret" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      channelId: deriveChannelId(pk),
      role: "device",
      deviceId: "phone",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(relayTicketQuery("relay+wss://relay.example.com", pk, "device", "phone", "bad")).rejects.toThrow(
      /密钥|无效/,
    );
    vi.unstubAllGlobals();
  });

  it("probeRelay 无密钥只查健康端点，有密钥真实签发票据", async () => {
    const pk = generateBoxKeyPair().publicKey;
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await probeRelay({ url: "wss://relay.example.com", desktopPk: pk });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://relay.example.com/health");
    vi.unstubAllGlobals();
  });
});
