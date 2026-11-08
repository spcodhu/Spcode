/**
 * 共享加密层测试向量（评审 R3-C12）：钉死 wire 格式，任何一端的实现漂移都会在这里炸出来。
 * 期望值由实现首次生成后钉住（sha256("abc") / RFC 4231 HMAC 为公开标准向量，可外部验证）。
 * 双端一致性不再需要「两份实现互相对比」——现在两端 import 的是同一个模块。
 *
 * 协议 v3：OTP KDF / secretbox 已删除；配对改为桌面公钥 box（sealPairHello），
 * relay 准入改为 X25519 共享密钥 + HMAC-SHA256（host proof / device grant），
 * 跨实现向量落在 fixtures/relay-admission-v3.json（与 spcod-relay 共享同一份）。
 */

import {
  b64decode,
  b64encode,
  boxDecrypt,
  boxEncrypt,
  buildDeviceGrant,
  buildHostProof,
  constantTimeEqual,
  decodeGrantParam,
  deriveChannelId,
  encodeGrantParam,
  generateBoxKeyPair,
  hmacSha256Sync,
  MAX_SEQ,
  openPairHello,
  RELAY_PAIR_SUBJECT,
  SeqCounter,
  SeqGuard,
  sealPairHello,
  verifyDeviceGrant,
  verifyHostProof,
} from "@spcode/shared/crypto";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/relay-admission-v3.json" with { type: "json" };

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("测试向量", () => {
  it("sha256 标准向量", async () => {
    const { sha256TextSync } = await import("@spcode/shared/crypto");
    expect(hex(sha256TextSync("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("HMAC-SHA256 RFC 4231 Test Case 2 钉死（relay 侧 Node createHmac 同向量）", () => {
    const key = new TextEncoder().encode("Jefe");
    const data = new TextEncoder().encode("what do ya want for nothing?");
    expect(hex(hmacSha256Sync(key, data))).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    // 超过 64 字节的密钥先 sha256 再填充（RFC 4231 Test Case 6 前 32 字节截断向量）
    const longKey = new Uint8Array(131).fill(0xaa);
    const longData = new TextEncoder().encode("Test Using Larger Than Block-Size Key - Hash Key First");
    expect(hex(hmacSha256Sync(longKey, longData))).toBe(
      "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
    );
  });

  it("constantTimeEqual：相等 true，任一字节/长度不同 false", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
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

  it("box 往返 + 错密钥返回 null（不抛错）", () => {
    const a = generateBoxKeyPair();
    const b = generateBoxKeyPair();
    const c = boxEncrypt("hello", a.publicKey, b.secretKey);
    expect(boxDecrypt(c, a.publicKey, b.secretKey)).toBe("hello");
    expect(boxDecrypt(c, a.publicKey, a.secretKey)).toBeNull();
  });
});

describe("配对握手密文（协议 v3）", () => {
  it("同 OTP 两次 sealPairHello 输出不同（随机 nonce）；桌面私钥可解开", () => {
    const desktop = generateBoxKeyPair();
    const phone = generateBoxKeyPair();
    const c1 = sealPairHello({ otp: "01234567", name: "手机" }, desktop.publicKey, phone.secretKey);
    const c2 = sealPairHello({ otp: "01234567", name: "手机" }, desktop.publicKey, phone.secretKey);
    expect(c1).not.toBe(c2);
    expect(openPairHello(c1, phone.publicKey, desktop.secretKey)).toEqual({ v: 3, otp: "01234567", name: "手机" });
    expect(openPairHello(c2, phone.publicKey, desktop.secretKey)).toEqual({ v: 3, otp: "01234567", name: "手机" });
  });

  it("用错误的桌面私钥 openPairHello 返回 null（relay 无桌面私钥不能离线穷举 OTP）", () => {
    const desktop = generateBoxKeyPair();
    const impostor = generateBoxKeyPair();
    const phone = generateBoxKeyPair();
    const c = sealPairHello({ otp: "01234567", name: "手机" }, desktop.publicKey, phone.secretKey);
    expect(openPairHello(c, phone.publicKey, impostor.secretKey)).toBeNull();
    // 外层手机公钥被替换也解不开（ECDH 绑定）
    expect(openPairHello(c, impostor.publicKey, desktop.secretKey)).toBeNull();
  });
});

describe("relay 准入 MAC（协议 v3）", () => {
  const desktop = generateBoxKeyPair();
  const relay = generateBoxKeyPair();
  const otherRelay = generateBoxKeyPair();
  const channelId = deriveChannelId(desktop.publicKey);

  it("host proof 往返：正确双方通过；换 relay 密钥 / 改 ts / 改 channel 均失败", () => {
    const ts = 1_700_000_000_000;
    const proof = buildHostProof(channelId, ts, relay.publicKey, desktop.secretKey);
    expect(verifyHostProof(channelId, ts, proof, desktop.publicKey, relay.secretKey)).toBe(true);
    expect(verifyHostProof(channelId, ts, proof, desktop.publicKey, otherRelay.secretKey)).toBe(false);
    expect(verifyHostProof(channelId, ts + 1, proof, desktop.publicKey, relay.secretKey)).toBe(false);
    expect(verifyHostProof("f".repeat(64), ts, proof, desktop.publicKey, relay.secretKey)).toBe(false);
    // 非法 base64 的 proof 不抛错
    expect(verifyHostProof(channelId, ts, "%%%", desktop.publicKey, relay.secretKey)).toBe(false);
  });

  it("device grant 往返：正确双方通过；换 relay 密钥 / 改 subject / 改 exp 均失败", () => {
    const exp = 1_700_000_600_000;
    const grant = buildDeviceGrant(channelId, "phone-1", exp, relay.publicKey, desktop.secretKey);
    expect(grant.exp).toBe(exp);
    expect(verifyDeviceGrant(channelId, "phone-1", grant, desktop.publicKey, relay.secretKey)).toBe(true);
    expect(verifyDeviceGrant(channelId, "phone-1", grant, desktop.publicKey, otherRelay.secretKey)).toBe(false);
    expect(verifyDeviceGrant(channelId, "phone-2", grant, desktop.publicKey, relay.secretKey)).toBe(false);
    expect(verifyDeviceGrant(channelId, RELAY_PAIR_SUBJECT, grant, desktop.publicKey, relay.secretKey)).toBe(false);
    expect(
      verifyDeviceGrant(channelId, "phone-1", { ...grant, exp: exp + 1 }, desktop.publicKey, relay.secretKey),
    ).toBe(false);
  });

  it("encodeGrantParam/decodeGrantParam 往返（base64url）；非法串返回 null", () => {
    const grant = buildDeviceGrant(
      channelId,
      RELAY_PAIR_SUBJECT,
      1_700_000_600_000,
      relay.publicKey,
      desktop.secretKey,
    );
    const param = encodeGrantParam(grant);
    expect(param).toMatch(/^1700000600000\.[A-Za-z0-9_-]+$/);
    expect(decodeGrantParam(param)).toEqual(grant);
    // 固定 mac 覆盖 +、/、= 三种需转义字符
    expect(encodeGrantParam({ exp: 5, mac: "+/8=" })).toBe("5.-_8");
    expect(decodeGrantParam("5.-_8")).toEqual({ exp: 5, mac: "+/8=" });
    expect(decodeGrantParam("")).toBeNull();
    expect(decodeGrantParam("no-dot")).toBeNull();
    expect(decodeGrantParam(".abc")).toBeNull();
    expect(decodeGrantParam("abc.def")).toBeNull();
    expect(decodeGrantParam("0.abc")).toBeNull();
    expect(decodeGrantParam("1.5.abc")).toBeNull();
    expect(decodeGrantParam("12.ab+c")).toBeNull();
    expect(decodeGrantParam("12.")).toBeNull();
  });

  it("跨实现向量：shared 实现算出的 host proof / device grant / pair grant 与 fixture 一致", () => {
    // 固定密钥推导的公钥 / channelId 也必须一致（relay 侧用同一份 JSON 校验）
    const desktopPk = b64encode(nacl.box.keyPair.fromSecretKey(b64decode(fixture.desktopSk)).publicKey);
    const relayPk = b64encode(nacl.box.keyPair.fromSecretKey(b64decode(fixture.relaySk)).publicKey);
    expect(desktopPk).toBe(fixture.desktopPk);
    expect(relayPk).toBe(fixture.relayPk);
    expect(deriveChannelId(desktopPk)).toBe(fixture.channelId);

    const { ts, proof } = fixture.hostProof;
    expect(buildHostProof(fixture.channelId, ts, fixture.relayPk, fixture.desktopSk)).toBe(proof);
    expect(verifyHostProof(fixture.channelId, ts, proof, fixture.desktopPk, fixture.relaySk)).toBe(true);

    const { subject, exp, mac } = fixture.deviceGrant;
    expect(buildDeviceGrant(fixture.channelId, subject, exp, fixture.relayPk, fixture.desktopSk)).toEqual({ exp, mac });
    expect(verifyDeviceGrant(fixture.channelId, subject, { exp, mac }, fixture.desktopPk, fixture.relaySk)).toBe(true);

    expect(buildDeviceGrant(fixture.channelId, RELAY_PAIR_SUBJECT, exp, fixture.relayPk, fixture.desktopSk)).toEqual(
      fixture.pairGrant,
    );
    expect(
      verifyDeviceGrant(fixture.channelId, RELAY_PAIR_SUBJECT, fixture.pairGrant, fixture.desktopPk, fixture.relaySk),
    ).toBe(true);
  });
});

describe("seq 上限（MAX_SEQ = MAX_SAFE_INTEGER - 1）", () => {
  it("SeqGuard 接受 MAX_SEQ，拒绝 MAX_SEQ+1、负数与非整数", () => {
    const g = new SeqGuard();
    expect(MAX_SEQ).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(g.accept(MAX_SEQ + 1)).toBe(false);
    expect(g.accept(Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(g.accept(Number.POSITIVE_INFINITY)).toBe(false);
    expect(g.accept(-1)).toBe(false);
    expect(g.accept(1.5)).toBe(false);
    expect(g.accept("1")).toBe(false);
    expect(g.accept(MAX_SEQ)).toBe(true);
    // 已到顶：任何后续 seq 都不可能严格递增
    expect(g.accept(MAX_SEQ + 1)).toBe(false);
  });

  it("SeqGuard.seed 把基准线钳到 [-1, MAX_SEQ]", () => {
    const g = new SeqGuard();
    g.seed(Number.MAX_SAFE_INTEGER);
    expect(g.accept(MAX_SEQ)).toBe(false); // 基准线已是 MAX_SEQ
    const g2 = new SeqGuard();
    g2.seed(-100);
    expect(g2.accept(0)).toBe(true);
  });

  it("SeqCounter.setNext 忽略 MAX_SEQ+1 与非法值；take 超过 MAX_SEQ 抛错", () => {
    const c = new SeqCounter();
    c.setNext(MAX_SEQ + 1);
    expect(c.peek()).toBe(0);
    c.setNext(-1);
    expect(c.peek()).toBe(0);
    c.setNext(2.5);
    expect(c.peek()).toBe(0);
    c.setNext(MAX_SEQ);
    expect(c.take()).toBe(MAX_SEQ);
    expect(() => c.take()).toThrow(/seq exhausted/);
  });
});
