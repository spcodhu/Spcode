/**
 * 配对管理单测：OTP 生成/单次有效/过期/错误锁定；
 * 设备密钥与已配对设备的持久化（0600、原子写、跨实例读回）。
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decodeGrantParam, generateBoxKeyPair, sealPairHello } from "../src/main/remote/crypto.js";
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

/** 构造协议 v3 配对密文：外层公钥与 box 内的手机私钥必须属于同一密钥对。 */
function makePairHello(pm: PairingManager, otp: string, name = "我的手机", phone = generateBoxKeyPair()) {
  const c = sealPairHello({ otp, name }, pm.getIdentity().publicKey, phone.secretKey);
  return { phone, c };
}

describe("设备密钥对", () => {
  it("首次生成并 0600 落盘；同实例与新实例均读回同一身份", () => {
    const pm = setup();
    const id1 = pm.getIdentity();
    expect(pm.getIdentity()).toEqual(id1);

    const keyFile = join((pm as unknown as { dir: string }).dir, "device.key");
    // Windows 无 POSIX 权限位，0600 断言仅 Unix 生效
    if (process.platform !== "win32") {
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    }

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
    const { phone, c } = makePairHello(pm, win.otp);
    const result = pm.tryPair(phone.publicKey, c);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.device.name).toBe("我的手机");
    expect(result.device.publicKey).toBe(phone.publicKey);
    expect(pm.findByPublicKey(phone.publicKey)?.id).toBe(result.device.id);

    // 持久化：原子写后 tmp 不残留，新实例读回
    const devicesFile = join((pm as unknown as { devicesFile: string }).devicesFile);
    if (process.platform !== "win32") {
      expect(statSync(devicesFile).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(readFileSync(devicesFile, "utf-8"))).toHaveLength(1);
    const baseDir = join((pm as unknown as { dir: string }).dir, "..");
    expect(new PairingManager({ baseDir }).devices()).toHaveLength(1);

    // 单次有效：同一 OTP 再用 → 窗口已消费（expired）
    expect(pm.tryPair(phone.publicKey, c)).toEqual({ ok: false, error: "expired" });
  });

  it("同公钥重复配对替换旧记录", () => {
    const pm = setup();
    const win1 = pm.beginPairing();
    const phone = generateBoxKeyPair();
    const { c } = makePairHello(pm, win1.otp, "旧名字", phone);
    pm.tryPair(phone.publicKey, c);
    const win2 = pm.beginPairing();
    const c2 = makePairHello(pm, win2.otp, "新名字", phone).c;
    const r = pm.tryPair(phone.publicKey, c2);
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
    // 协议 v3：错误 OTP 仍在合法 box 内，解开后分类为 otp_mismatch。
    const phone = generateBoxKeyPair();
    for (let i = 0; i < 4; i++) {
      const attempt = makePairHello(pm, wrong, "猜测机", phone);
      expect(pm.tryPair(phone.publicKey, attempt.c)).toEqual({ ok: false, error: "otp_mismatch" });
    }
    // 第 5 次错误 → 锁定
    expect(pm.tryPair(phone.publicKey, makePairHello(pm, wrong, "猜测机", phone).c)).toEqual({
      ok: false,
      error: "otp_mismatch",
    });
    expect(pm.lockedRemainingMs()).toBeGreaterThan(0);

    const { c } = makePairHello(pm, win.otp, "我的手机", phone);
    expect(pm.tryPair(phone.publicKey, c)).toEqual({ ok: false, error: "locked" });
    // 锁定中新开窗口也被拒
    pm.beginPairing();
    expect(pm.tryPair(phone.publicKey, c)).toEqual({ ok: false, error: "locked" });

    now = t0 + 10 * 60_000; // 锁定期满
    const win2 = pm.beginPairing();
    const good = makePairHello(pm, win2.otp, "我的手机", phone);
    expect(pm.tryPair(phone.publicKey, good.c).ok).toBe(true);
  });

  it("非法密文 → bad_payload，窗口保留可用合法配对重试", () => {
    const pm = setup();
    const win = pm.beginPairing();
    const phone = generateBoxKeyPair();
    expect(pm.tryPair(phone.publicKey, "%%%not-base64%%%")).toEqual({ ok: false, error: "bad_payload" });
    const good = makePairHello(pm, win.otp, "我的手机", phone);
    expect(pm.tryPair(phone.publicKey, good.c).ok).toBe(true);
  });

  it("非法/随机密文同样计入在线猜测：5 次后锁定，正确 OTP 也被拒", () => {
    const t0 = 1_000_000;
    const now = t0;
    const pm = setup(() => now);
    const win = pm.beginPairing();
    const phone = generateBoxKeyPair();
    const junk = ["not-base64%%%", "AAAA", Buffer.from("random ciphertext").toString("base64")];
    for (let i = 0; i < 5; i++) {
      expect(pm.tryPair(phone.publicKey, junk[i % junk.length])).toEqual({ ok: false, error: "bad_payload" });
    }
    expect(pm.lockedRemainingMs()).toBe(10 * 60_000);
    const good = makePairHello(pm, win.otp, "我的手机", phone);
    expect(pm.tryPair(phone.publicKey, good.c)).toEqual({ ok: false, error: "locked" });
  });

  it("正确 OTP 配非法公钥、非 8 位 OTP 均不抛错，分别分类为 bad_payload / otp_mismatch", () => {
    const pm = setup();
    const win = pm.beginPairing();
    const phone = generateBoxKeyPair();
    const good = makePairHello(pm, win.otp, "我的手机", phone);
    expect(pm.tryPair("not-a-public-key", good.c)).toEqual({ ok: false, error: "bad_payload" });
    const shortOtp = sealPairHello({ otp: "1234567", name: "格式错误" }, pm.getIdentity().publicKey, phone.secretKey);
    expect(pm.tryPair(phone.publicKey, shortOtp)).toEqual({ ok: false, error: "otp_mismatch" });
    expect(pm.lockedRemainingMs()).toBe(0);
    expect(pm.tryPair(phone.publicKey, good.c).ok).toBe(true);
  });

  it("窗口过期 → expired", () => {
    const t0 = 1_000_000;
    let now = t0;
    const pm = setup(() => now);
    const win = pm.beginPairing();
    now = t0 + 6 * 60_000;
    const { phone, c } = makePairHello(pm, win.otp);
    expect(pm.tryPair(phone.publicKey, c)).toEqual({ ok: false, error: "expired" });
  });
});

describe("设备管理", () => {
  it("removeDevice：存在的删除返回 true，不存在返回 false", () => {
    const pm = setup();
    const win = pm.beginPairing();
    const { phone, c } = makePairHello(pm, win.otp);
    const r = pm.tryPair(phone.publicKey, c);
    if (!r.ok) throw new Error("pair failed");
    expect(pm.removeDevice(r.device.id)).toBe(true);
    expect(pm.devices()).toHaveLength(0);
    expect(pm.removeDevice(r.device.id)).toBe(false);
  });

  it("QR payload 格式（QR v4）：携带桌面公钥、OTP、可选 relay_key 与 relay_grant", () => {
    const pm = setup();
    const win = pm.beginPairing();
    const payload = pm.buildQrPayload(["http://192.168.1.5:8123"], win);
    const url = new URL(payload);
    expect(url.protocol).toBe("spcode-remote:");
    expect(url.host).toBe("pair");
    expect(url.searchParams.get("v")).toBe("4");
    expect(url.searchParams.get("hosts")).toBe("http://192.168.1.5:8123");
    expect(url.searchParams.get("desktop_pk")).toBe(pm.getIdentity().publicKey);
    expect(url.searchParams.get("otp")).toBe(win.otp);
    expect(url.searchParams.get("relay_grant")).toBeNull();
    const grant = { exp: win.expiresAt, mac: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" };
    const withRelay = new URL(pm.buildQrPayload(["relay+wss://relay.example.com"], win, "server-secret", grant));
    expect(withRelay.searchParams.get("relay_key")).toBe("server-secret");
    expect(decodeGrantParam(withRelay.searchParams.get("relay_grant") ?? "")).toEqual(grant);
  });
});
