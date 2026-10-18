/**
 * 共享加密层测试向量（评审 R3-C12）：钉死 wire 格式，任何一端的实现漂移都会在这里炸出来。
 * 期望值由实现首次生成后钉住（sha256("abc") 为公开标准向量，可外部验证）。
 * 双端一致性不再需要「两份实现互相对比」——现在两端 import 的是同一个模块。
 */

import {
  b64decode,
  b64encode,
  boxDecrypt,
  boxEncrypt,
  deriveChannelId,
  deriveOtpKey,
  generateBoxKeyPair,
  secretboxDecrypt,
  secretboxEncrypt,
} from "@spcode/shared/crypto";
import { describe, expect, it } from "vitest";

describe("测试向量", () => {
  it("sha256 标准向量", async () => {
    const { sha256TextSync } = await import("@spcode/shared/crypto");
    expect([...sha256TextSync("abc")].map((b) => b.toString(16).padStart(2, "0")).join("")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("OTP KDF（协议 v2，迭代 5 万轮）钉死", () => {
    expect([...deriveOtpKey("01234567")].map((b) => b.toString(16).padStart(2, "0")).join("")).toBe(
      "56a6707702c9cac423a16314dd0cf4478dc79949cc8a22818d7df317f7292dc9",
    );
    expect([...deriveOtpKey("00000000")].map((b) => b.toString(16).padStart(2, "0")).join("")).toBe(
      "e08e524c919dedc2276ca1cf25fcb984e5451cc37458ad11dd3deb4d57f20615",
    );
  });

  it("base64 编码向量（含空输入与单字节）", () => {
    expect(b64encode(new Uint8Array([1, 2, 3, 254, 255]))).toBe("AQID/v8=");
    expect(b64encode(new Uint8Array([]))).toBe("");
    expect(b64encode(new Uint8Array([255]))).toBe("/w==");
    expect([...b64decode("AQID/v8=")]).toEqual([1, 2, 3, 254, 255]);
    expect(b64decode("")).toHaveLength(0);
  });

  it("channelId = sha256(公钥原始 32 字节) hex", () => {
    expect(deriveChannelId("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=")).toBe(
      "72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793",
    );
  });

  it("box/secretbox 往返 + 错密钥返回 null（不抛错）", () => {
    const a = generateBoxKeyPair();
    const b = generateBoxKeyPair();
    const c = boxEncrypt("hello", a.publicKey, b.secretKey);
    expect(boxDecrypt(c, a.publicKey, b.secretKey)).toBe("hello");
    expect(boxDecrypt(c, a.publicKey, a.secretKey)).toBeNull();

    const key = deriveOtpKey("12345678");
    const s = secretboxEncrypt("payload", key);
    expect(secretboxDecrypt(s, key)).toBe("payload");
    expect(secretboxDecrypt(s, deriveOtpKey("87654321"))).toBeNull();
  });
});
