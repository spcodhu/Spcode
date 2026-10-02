/**
 * 配对管理单测：OTP 生成/单次有效/过期/错误锁定；
 * 设备密钥与已配对设备的持久化（0600、原子写、跨实例读回）。
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { deriveOtpKey, generateBoxKeyPair, secretboxEncrypt } from "../src/main/remote/crypto.js";
import { deviceFingerprint, PairingManager } from "../src/main/remote/pairing.js";

let dir = "";

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function setup(now?: () => number) {
  if (!dir) dir = mkdtempSync(join(tmpdir(), "spcode-remote-pair-"));
  const baseDir = join(dir, `case-${Math.random().toString(36).slice(2)}`);
  return new PairingManager({ baseDir, now });
}

/** 构造一次合法握手的密文（模拟手机端） */
function makePairCiphertext(otp: string, name = "我的手机") {
  const phone = generateBoxKeyPair();
  const c = secretboxEncrypt(JSON.stringify({ publicKey: phone.publicKey, name }), deriveOtpKey(otp));
  return { phone, c };
}

describe("设备密钥对", () => {
  it("首次生成并 0600 落盘；同实例与新实例均读回同一身份", () => {
    const pm = setup();
    const id1 = pm.getIdentity();
    expect(pm.getIdentity()).toEqual(id1);

    const keyFile = join((pm as unknown as { dir: string }).dir, "device.key");
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);

    // 新实例（同目录）应读回同一密钥
    const pm2 = new PairingManager({ baseDir: join((pm as unknown as { dir: string }).dir, "..") });
    // baseDir 语义是 ~/.spcode 根，remote 子目录由内部拼接
    expect(pm2.getIdentity()).toEqual(id1);
  });

  it("指纹 = 公钥 sha256 前 8 位 hex", () => {
    const fp = deviceFingerprint("cGtfZXhhbXBsZQ==");
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("OTP 配对窗口", () => {
  it("8 位数字 OTP，5 分钟有效", () => {
    const t0 = 1_000_000;
    let now = t0;
    const pm = setup(() => now);
    const win = pm.beginPairing();
    expect(win.otp).toMatch(/^\d{8}$/);
    expect(win.expiresAt).toBe(t0 + 5 * 60_000);
    expect(pm.currentPairing()).toEqual(win);
    now = t0 + 5 * 60_000; // 到期
    expect(pm.currentPairing()).toBeNull();
  });

  it("配对成功：设备落盘（0600），新实例可读回；窗口单次有效", () => {
    const pm = setup();
    const win = pm.beginPairing();
    const { phone, c } = makePairCiphertext(win.otp);
    const result = pm.tryPair(win.otp, c);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.device.name).toBe("我的手机");
    expect(result.device.publicKey).toBe(phone.publicKey);
    expect(pm.findByPublicKey(phone.publicKey)?.id).toBe(result.device.id);

    // 持久化：原子写后 tmp 不残留，新实例读回
    const devicesFile = join((pm as unknown as { devicesFile: string }).devicesFile);
    expect(statSync(devicesFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(devicesFile, "utf-8"))).toHaveLength(1);
    const baseDir = join((pm as unknown as { dir: string }).dir, "..");
    expect(new PairingManager({ baseDir }).devices()).toHaveLength(1);

    // 单次有效：同一 OTP 再用 → 窗口已消费（expired）
    expect(pm.tryPair(win.otp, c)).toEqual({ ok: false, error: "expired" });
  });

  it("同公钥重复配对替换旧记录", () => {
    const pm = setup();
    const win1 = pm.beginPairing();
    const { phone, c } = makePairCiphertext(win1.otp, "旧名字");
    pm.tryPair(win1.otp, c);
    const win2 = pm.beginPairing();
    const c2 = secretboxEncrypt(JSON.stringify({ publicKey: phone.publicKey, name: "新名字" }), deriveOtpKey(win2.otp));
    const r = pm.tryPair(win2.otp, c2);
    expect(r.ok).toBe(true);
    expect(pm.devices()).toHaveLength(1);
    expect(pm.devices()[0]?.name).toBe("新名字");
  });

  it("OTP 错误计数：5 次后锁定 10 分钟，正确 OTP 也被拒", () => {
    const t0 = 1_000_000;
    let now = t0;
    const pm = setup(() => now);
    const win = pm.beginPairing();
    const wrong = win.otp === "00000000" ? "00000001" : "00000000"; // 保证与真实 OTP 不同
    for (let i = 0; i < 4; i++) {
      expect(pm.tryPair(wrong, "whatever")).toEqual({ ok: false, error: "otp_mismatch" });
    }
    // 第 5 次错误 → 锁定
    expect(pm.tryPair(wrong, "whatever")).toEqual({ ok: false, error: "otp_mismatch" });
    expect(pm.lockedRemainingMs()).toBeGreaterThan(0);

    const { c } = makePairCiphertext(win.otp);
    expect(pm.tryPair(win.otp, c)).toEqual({ ok: false, error: "locked" });
    // 锁定中新开窗口也被拒
    pm.beginPairing();
    expect(pm.tryPair(win.otp, c)).toEqual({ ok: false, error: "locked" });

    now = t0 + 10 * 60_000; // 锁定期满
    const win2 = pm.beginPairing();
    const good = makePairCiphertext(win2.otp);
    expect(pm.tryPair(win2.otp, good.c).ok).toBe(true);
  });

  it("OTP 正确但密文损坏 → bad_payload（窗口保留可重试）", () => {
    const pm = setup();
    const win = pm.beginPairing();
    expect(pm.tryPair(win.otp, "aGVsbG8gd29ybGQ=")).toEqual({ ok: false, error: "bad_payload" });
    const good = makePairCiphertext(win.otp);
    expect(pm.tryPair(win.otp, good.c).ok).toBe(true);
  });

  it("窗口过期 → expired", () => {
    const t0 = 1_000_000;
    let now = t0;
    const pm = setup(() => now);
    const win = pm.beginPairing();
    now = t0 + 6 * 60_000;
    const { c } = makePairCiphertext(win.otp);
    expect(pm.tryPair(win.otp, c)).toEqual({ ok: false, error: "expired" });
  });
});

describe("设备管理", () => {
  it("removeDevice：存在的删除返回 true，不存在返回 false", () => {
    const pm = setup();
    const win = pm.beginPairing();
    const { c } = makePairCiphertext(win.otp);
    const r = pm.tryPair(win.otp, c);
    if (!r.ok) throw new Error("pair failed");
    expect(pm.removeDevice(r.device.id)).toBe(true);
    expect(pm.devices()).toHaveLength(0);
    expect(pm.removeDevice(r.device.id)).toBe(false);
  });

  it("QR payload 格式：spcode-remote://pair?v=1&hosts=…&desktop_pk=…&otp=…", () => {
    const pm = setup();
    const win = pm.beginPairing();
    const payload = pm.buildQrPayload(["http://192.168.1.5:8123"], win);
    const url = new URL(payload);
    expect(url.protocol).toBe("spcode-remote:");
    expect(url.host).toBe("pair");
    expect(url.searchParams.get("v")).toBe("1");
    expect(url.searchParams.get("hosts")).toBe("http://192.168.1.5:8123");
    expect(url.searchParams.get("desktop_pk")).toBe(pm.getIdentity().publicKey);
    expect(url.searchParams.get("otp")).toBe(win.otp);
  });
});
