/**
 * 协议层单测：base64 / sha256 / NaCl 编解码（与桌面端 crypto 模块交叉验证）/ QR 解析 / seq。
 * 交叉验证直接 import apps/desktop 的 remote/crypto.ts——两端实现不一致在这里就会暴露。
 */

import {
  b64decode,
  b64encode,
  boxDecrypt,
  boxEncrypt,
  encodeGrantParam,
  generateBoxKeyPair,
  hmacSha256Sync,
  isValidPublicKey,
  openPairHello,
  openPayload,
  pairOpen,
  SeqCounter,
  SeqGuard,
  sealPairHello,
  sealPayload,
  sha256Sync,
} from "@spcode/shared/crypto";
import { describe, expect, it } from "vitest";
import {
  b64decode as desktopB64decode,
  b64encode as desktopB64encode,
  boxDecrypt as desktopBoxDecrypt,
  boxEncrypt as desktopBoxEncrypt,
  generateBoxKeyPair as desktopGenerateBoxKeyPair,
  openPairHello as desktopOpenPairHello,
  sealPairHello as desktopSealPairHello,
} from "../../desktop/src/main/remote/crypto.js";
import { parseQrPayload } from "../src/lib/qr";

describe("base64", () => {
  it("与桌面端实现互编码一致", () => {
    const samples = [
      new Uint8Array(0),
      new Uint8Array([1]),
      new Uint8Array([1, 2]),
      new Uint8Array([255, 0, 127, 63]),
      crypto.getRandomValues(new Uint8Array(64)),
    ];
    for (const s of samples) {
      expect(b64encode(s)).toBe(desktopB64encode(s));
      expect([...b64decode(desktopB64encode(s))]).toEqual([...s]);
      expect([...desktopB64decode(b64encode(s))]).toEqual([...s]);
    }
  });

  it("非法字符抛错", () => {
    expect(() => b64decode("a*b=")).toThrow();
  });
});

describe("sha256", () => {
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

  it("纯 JS 实现符合标准向量", () => {
    const enc = new TextEncoder();
    expect(hex(sha256Sync(enc.encode("")))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hex(sha256Sync(enc.encode("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // 跨 64 字节块边界
    expect(hex(sha256Sync(enc.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("HMAC-SHA256 符合 RFC 4231 Test Case 2", () => {
    const enc = new TextEncoder();
    expect(hex(hmacSha256Sync(enc.encode("Jefe"), enc.encode("what do ya want for nothing?")))).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });
});

describe("NaCl box / pair hello（与桌面端交叉）", () => {
  it("sealPairHello 与 openPairHello 双端互通，随机 nonce 避免密文复用", () => {
    const phone = generateBoxKeyPair();
    const desktop = desktopGenerateBoxKeyPair();
    const inner = { otp: "87654321", name: "测试机" };

    const fromPhone = sealPairHello(inner, desktop.publicKey, phone.secretKey);
    expect(desktopOpenPairHello(fromPhone, phone.publicKey, desktop.secretKey)).toEqual({ v: 3, ...inner });
    const fromDesktop = desktopSealPairHello(inner, desktop.publicKey, phone.secretKey);
    expect(openPairHello(fromDesktop, phone.publicKey, desktop.secretKey)).toEqual({ v: 3, ...inner });
    expect(sealPairHello(inner, desktop.publicKey, phone.secretKey)).not.toBe(fromPhone);
  });

  it("错误桌面私钥无法解开 pair hello", () => {
    const phone = generateBoxKeyPair();
    const desktop = generateBoxKeyPair();
    const wrongDesktop = generateBoxKeyPair();
    const sealed = sealPairHello({ otp: "12345678", name: "测试机" }, desktop.publicKey, phone.secretKey);
    expect(openPairHello(sealed, phone.publicKey, wrongDesktop.secretKey)).toBeNull();
  });

  it("手机 boxEncrypt → 桌面 boxDecrypt；桌面 boxEncrypt → 手机 pairOpen/boxDecrypt", () => {
    const phone = generateBoxKeyPair();
    const desktop = desktopGenerateBoxKeyPair();

    // 手机加密 → 桌面解密
    const c1 = boxEncrypt("hello", desktop.publicKey, phone.secretKey);
    expect(desktopBoxDecrypt(c1, phone.publicKey, desktop.secretKey)).toBe("hello");

    // 桌面加密 pair_ack → 手机 pairOpen
    const ackInner = { desktopPk: desktop.publicKey, deviceId: "dev-1" };
    const c2 = desktopBoxEncrypt(JSON.stringify(ackInner), phone.publicKey, desktop.secretKey);
    expect(pairOpen(c2, desktop.publicKey, phone.secretKey)).toEqual(ackInner);

    // 业务载荷 round-trip
    const payload = { kind: "command" as const, command: { type: "session.list" as const } };
    const c3 = sealPayload(payload, desktop.publicKey, phone.secretKey);
    expect(openPayload(c3, desktop.publicKey, phone.secretKey)).toEqual(payload);

    // 错密钥 / 篡改 → null（不抛错）
    const stranger = generateBoxKeyPair();
    expect(boxDecrypt(c1, stranger.publicKey, phone.secretKey)).toBeNull();
    expect(boxDecrypt(`${c1.slice(0, -4)}AAAA`, desktop.publicKey, phone.secretKey)).toBeNull();
  });

  it("isValidPublicKey", () => {
    const kp = generateBoxKeyPair();
    expect(isValidPublicKey(kp.publicKey)).toBe(true);
    expect(isValidPublicKey("not-base64!!")).toBe(false);
    expect(isValidPublicKey(b64encode(new Uint8Array(8)))).toBe(false);
  });
});

describe("seq", () => {
  it("SeqCounter 从 0 递增；SeqGuard 拒绝乱序/重放", () => {
    const counter = new SeqCounter();
    expect([counter.take(), counter.take(), counter.take()]).toEqual([0, 1, 2]);

    const guard = new SeqGuard();
    expect(guard.accept(0)).toBe(true);
    expect(guard.accept(1)).toBe(true);
    expect(guard.accept(1)).toBe(false); // 重放
    expect(guard.accept(0)).toBe(false); // 乱序
    expect(guard.accept(3)).toBe(true); // 跳号仍算递增（防重放语义）
    expect(guard.accept(1.5)).toBe(false);
    expect(guard.accept("4")).toBe(false);
    guard.reset();
    expect(guard.accept(0)).toBe(true);
  });
});

describe("QR payload 解析", () => {
  const kp = generateBoxKeyPair();
  const build = (hosts: string[], pk = kp.publicKey, otp = "12345678", suffix = "") =>
    `spcode-remote://pair?v=4&hosts=${encodeURIComponent(hosts.join(","))}&desktop_pk=${encodeURIComponent(pk)}&otp=${otp}${suffix}`;

  it("单 host（URL 编码）", () => {
    const p = parseQrPayload(build(["http://192.168.1.5:8123"]));
    expect(p).toEqual({ version: 4, hosts: ["http://192.168.1.5:8123"], desktopPk: kp.publicKey, otp: "12345678" });
  });

  it("多 host（逗号分隔后整体编码）", () => {
    const p = parseQrPayload(build(["http://192.168.1.5:8123", "http://100.64.1.2:8123"]));
    expect(p.hosts).toEqual(["http://192.168.1.5:8123", "http://100.64.1.2:8123"]);
  });

  it("v1/v2/v3 一律报告桌面版本过旧", () => {
    for (const version of [1, 2, 3]) {
      const old = build(["http://192.168.1.5:8123"]).replace("v=4", `v=${version}`);
      expect(() => parseQrPayload(old)).toThrowError(expect.objectContaining({ key: "qr.oldVersion" }));
    }
  });

  it("v4 正常解析 relay_grant，非法格式报告 qr.relayGrant", () => {
    const relayGrant = { exp: Date.now() + 60_000, mac: b64encode(new Uint8Array(32).fill(7)) };
    const encoded = encodeGrantParam(relayGrant);
    const parsed = parseQrPayload(
      build(["relay+wss://relay.example.com"], undefined, undefined, `&relay_grant=${encoded}`),
    );
    expect(parsed.relayGrant).toEqual(relayGrant);
    expect(() =>
      parseQrPayload(build(["relay+wss://relay.example.com"], undefined, undefined, "&relay_grant=not-a-grant")),
    ).toThrowError(expect.objectContaining({ key: "qr.relayGrant" }));
  });

  it("非法输入逐一报错", () => {
    expect(() => parseQrPayload("http://example.com")).toThrow(/配对码/);
    expect(() => parseQrPayload("spcode-remote://pair")).toThrow(/参数/);
    expect(() => parseQrPayload(build(["http://1.2.3.4:1"], "bad-key"))).toThrow(/公钥/);
    expect(() => parseQrPayload(build(["http://1.2.3.4:1"], undefined, "123"))).toThrow(/OTP/);
    expect(() =>
      parseQrPayload("spcode-remote://pair?v=5&hosts=http%3A%2F%2F1.2.3.4%3A1&desktop_pk=x&otp=12345678"),
    ).toThrow(/版本/);
    expect(() => parseQrPayload(build(["ftp://x"]))).toThrow(/地址/);
  });
});
