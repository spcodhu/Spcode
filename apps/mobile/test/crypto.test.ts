/**
 * 协议层单测：base64 / sha256 / NaCl 编解码（与桌面端 crypto 模块交叉验证）/ QR 解析 / seq。
 * 交叉验证直接 import apps/desktop 的 remote/crypto.ts——两端实现不一致在这里就会暴露。
 */

import { describe, expect, it } from "vitest";
import {
  b64decode as desktopB64decode,
  b64encode as desktopB64encode,
  boxDecrypt as desktopBoxDecrypt,
  boxEncrypt as desktopBoxEncrypt,
  deriveOtpKey as desktopDeriveOtpKey,
  generateBoxKeyPair as desktopGenerateBoxKeyPair,
  secretboxDecrypt as desktopSecretboxDecrypt,
  secretboxEncrypt as desktopSecretboxEncrypt,
} from "../../desktop/src/main/remote/crypto.js";
import { b64decode, b64encode } from "../src/lib/base64";
import {
  boxOpen,
  boxSeal,
  deriveOtpKey,
  generateKeyPair,
  isValidPublicKey,
  openPayload,
  pairOpen,
  pairSeal,
  SeqCounter,
  SeqGuard,
  sealPayload,
  secretboxOpen,
  secretboxSeal,
} from "../src/lib/crypto";
import { parseQrPayload } from "../src/lib/qr";
import { sha256Sync } from "../src/lib/sha256";

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

  it("OTP 派生密钥与桌面端一致", async () => {
    const otp = "01234567";
    const mobileKey = await deriveOtpKey(otp);
    const desktopKey = desktopDeriveOtpKey(otp);
    expect([...mobileKey]).toEqual([...desktopKey]);
  });
});

describe("NaCl secretbox / box（与桌面端交叉）", () => {
  it("手机 pairSeal → 桌面 secretboxDecrypt 可解；桌面 secretboxEncrypt → 手机 secretboxOpen 可解", async () => {
    const otp = "87654321";
    const inner = { publicKey: "pk", name: "测试机" };
    const sealed = await pairSeal(inner, otp);
    expect(JSON.parse(desktopSecretboxDecrypt(sealed, desktopDeriveOtpKey(otp))!)).toEqual(inner);

    const fromDesktop = desktopSecretboxEncrypt(JSON.stringify(inner), desktopDeriveOtpKey(otp));
    expect(secretboxOpen(fromDesktop, await deriveOtpKey(otp))).toBe(JSON.stringify(inner));

    expect(secretboxSeal("x", await deriveOtpKey(otp))).not.toBe(sealed); // nonce 随机
  });

  it("手机 boxSeal → 桌面 boxDecrypt；桌面 boxEncrypt → 手机 pairOpen/boxOpen", () => {
    const phone = generateKeyPair();
    const desktop = desktopGenerateBoxKeyPair();

    // 手机加密 → 桌面解密
    const c1 = boxSeal("hello", desktop.publicKey, phone.secretKey);
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
    const stranger = generateKeyPair();
    expect(boxOpen(c1, stranger.publicKey, phone.secretKey)).toBeNull();
    expect(boxOpen(`${c1.slice(0, -4)}AAAA`, desktop.publicKey, phone.secretKey)).toBeNull();
  });

  it("isValidPublicKey", () => {
    const kp = generateKeyPair();
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
  const kp = generateKeyPair();
  const build = (hosts: string[], pk = kp.publicKey, otp = "12345678") =>
    `spcode-remote://pair?v=2&hosts=${encodeURIComponent(hosts.join(","))}&desktop_pk=${encodeURIComponent(pk)}&otp=${otp}`;

  it("单 host（URL 编码）", () => {
    const p = parseQrPayload(build(["http://192.168.1.5:8123"]));
    expect(p).toEqual({ version: 2, hosts: ["http://192.168.1.5:8123"], desktopPk: kp.publicKey, otp: "12345678" });
  });

  it("多 host（逗号分隔后整体编码）", () => {
    const p = parseQrPayload(build(["http://192.168.1.5:8123", "http://100.64.1.2:8123"]));
    expect(p.hosts).toEqual(["http://192.168.1.5:8123", "http://100.64.1.2:8123"]);
  });

  it("非法输入逐一报错", () => {
    expect(() => parseQrPayload("http://example.com")).toThrow(/配对码/);
    expect(() => parseQrPayload("spcode-remote://pair")).toThrow(/参数/);
    expect(() => parseQrPayload(build(["http://1.2.3.4:1"], "bad-key"))).toThrow(/公钥/);
    expect(() => parseQrPayload(build(["http://1.2.3.4:1"], undefined, "123"))).toThrow(/OTP/);
    expect(() =>
      parseQrPayload("spcode-remote://pair?v=3&hosts=http%3A%2F%2F1.2.3.4%3A1&desktop_pk=x&otp=12345678"),
    ).toThrow(/版本/);
    expect(() => parseQrPayload(build(["ftp://x"]))).toThrow(/地址/);
  });
});
