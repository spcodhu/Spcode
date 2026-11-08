/**
 * 远程控制加密层单测：密钥对生成、box 加解密、v3 配对密文往返、
 * 篡改/错钥解密失败、seq 重放拒绝。
 */
import { describe, expect, it } from "vitest";
import {
  b64decode,
  boxDecrypt,
  boxEncrypt,
  generateBoxKeyPair,
  generateOtp,
  isValidPublicKey,
  openPairHello,
  SeqCounter,
  SeqGuard,
  sealPairHello,
} from "../src/main/remote/crypto.js";

describe("密钥对生成", () => {
  it("生成合法 base64 密钥对（公钥/私钥各 32 字节）", () => {
    const kp = generateBoxKeyPair();
    expect(isValidPublicKey(kp.publicKey)).toBe(true);
    expect(b64decode(kp.secretKey)).toHaveLength(32);
    expect(isValidPublicKey("not-a-key")).toBe(false);
    expect(isValidPublicKey("")).toBe(false);
  });

  it("两次生成的密钥对不同", () => {
    expect(generateBoxKeyPair().publicKey).not.toBe(generateBoxKeyPair().publicKey);
  });
});

describe("NaCl box 加解密", () => {
  it("往返：桌面私钥 × 手机公钥 加密，手机私钥 × 桌面公钥 解密", () => {
    const desktop = generateBoxKeyPair();
    const phone = generateBoxKeyPair();
    const msg = JSON.stringify({ hello: "远程控制", n: 42 });
    const c = boxEncrypt(msg, phone.publicKey, desktop.secretKey);
    expect(boxDecrypt(c, desktop.publicKey, phone.secretKey)).toBe(msg);
  });

  it("反向也成立（手机→桌面）", () => {
    const desktop = generateBoxKeyPair();
    const phone = generateBoxKeyPair();
    const c = boxEncrypt("ping", desktop.publicKey, phone.secretKey);
    expect(boxDecrypt(c, phone.publicKey, desktop.secretKey)).toBe("ping");
  });

  it("篡改密文 → 解密失败（返回 null，不抛错）", () => {
    const desktop = generateBoxKeyPair();
    const phone = generateBoxKeyPair();
    const c = boxEncrypt("secret", phone.publicKey, desktop.secretKey);
    const buf = Buffer.from(c, "base64");
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff; // 翻转最后一字节
    expect(boxDecrypt(buf.toString("base64"), desktop.publicKey, phone.secretKey)).toBeNull();
  });

  it("错密钥 / 非法 base64 → null", () => {
    const a = generateBoxKeyPair();
    const b = generateBoxKeyPair();
    const c = boxEncrypt("x", b.publicKey, a.secretKey);
    expect(boxDecrypt(c, a.publicKey, generateBoxKeyPair().secretKey)).toBeNull();
    expect(boxDecrypt("%%%not-base64%%%", a.publicKey, b.secretKey)).toBeNull();
  });
});

describe("配对握手 box（协议 v3）", () => {
  it("sealPairHello/openPairHello 往返，包含 v=3 内层标签；同 OTP 随机 nonce 产生不同密文", () => {
    const desktop = generateBoxKeyPair();
    const phone = generateBoxKeyPair();
    const inner = { otp: "12345678", name: "手机" };
    const c1 = sealPairHello(inner, desktop.publicKey, phone.secretKey);
    const c2 = sealPairHello(inner, desktop.publicKey, phone.secretKey);
    expect(c1).not.toBe(c2);
    expect(openPairHello(c1, phone.publicKey, desktop.secretKey)).toEqual({ v: 3, ...inner });
    expect(openPairHello(c2, phone.publicKey, desktop.secretKey)).toEqual({ v: 3, ...inner });
  });

  it("篡改、错设备公钥、错桌面私钥与非法密文均解密失败且不抛错", () => {
    const desktop = generateBoxKeyPair();
    const phone = generateBoxKeyPair();
    const stranger = generateBoxKeyPair();
    const c = sealPairHello({ otp: "12345678", name: "手机" }, desktop.publicKey, phone.secretKey);
    const tampered = Buffer.from(c, "base64");
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    expect(openPairHello(tampered.toString("base64"), phone.publicKey, desktop.secretKey)).toBeNull();
    expect(openPairHello(c, stranger.publicKey, desktop.secretKey)).toBeNull();
    expect(openPairHello(c, phone.publicKey, stranger.secretKey)).toBeNull();
    expect(openPairHello("%%%not-base64%%%", phone.publicKey, desktop.secretKey)).toBeNull();
  });

  it("OTP 生成：8 位数字，允许前导零", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateOtp()).toMatch(/^\d{8}$/);
    }
  });
});

describe("seq 防重放", () => {
  it("SeqGuard 只接受严格递增整数，重复/回退/非整数均拒绝", () => {
    const g = new SeqGuard();
    expect(g.accept(0)).toBe(true);
    expect(g.accept(1)).toBe(true);
    expect(g.accept(1)).toBe(false); // 重放
    expect(g.accept(0)).toBe(false); // 回退
    expect(g.accept(5)).toBe(true); // 跳号允许（丢包容忍）
    expect(g.accept(4)).toBe(false);
    expect(g.accept(1.5)).toBe(false);
    expect(g.accept("6")).toBe(false);
    expect(g.accept(Number.NaN)).toBe(false);
  });

  it("reset 后重新从 0 计", () => {
    const g = new SeqGuard();
    g.accept(3);
    g.reset();
    expect(g.accept(0)).toBe(true);
  });

  it("SeqCounter 从 0 单调递增", () => {
    const c = new SeqCounter();
    expect([c.take(), c.take(), c.take()]).toEqual([0, 1, 2]);
  });
});
