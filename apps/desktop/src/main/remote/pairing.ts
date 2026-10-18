/**
 * 远程控制配对管理：
 * - 桌面长期设备密钥对：~/.spcode/remote/device.key（0600，原子写，损坏自动备份重建）
 * - 已配对设备列表：~/.spcode/remote/devices.json（原子写）
 * - OTP 配对窗口：8 位数字、单次有效、5 分钟过期；连续 5 次错误锁定 10 分钟
 * - QR payload 生成（spcode-remote://pair?…，格式见 shared/src/remote.ts 注释）
 */

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PairedDevice, PairHelloInner } from "@spcode/shared";
import { readJsonFile, resolveSpcodeHome } from "@spcode/shared/node";
import {
  type BoxKeyPairB64,
  deriveOtpKey,
  generateBoxKeyPair,
  generateOtp,
  isValidPublicKey,
  secretboxDecrypt,
} from "./crypto.js";

const OTP_TTL_MS = 5 * 60_000;
const MAX_OTP_FAILURES = 5;
const LOCKOUT_MS = 10 * 60_000;

export interface PairingWindow {
  otp: string;
  expiresAt: number;
}

export type PairError = "locked" | "expired" | "otp_mismatch" | "bad_payload";

export type PairResult = { ok: true; device: PairedDevice } | { ok: false; error: PairError };

function validateIdentity(data: unknown): BoxKeyPairB64 | null {
  if (!data || typeof data !== "object") return null;
  const r = data as Record<string, unknown>;
  if (!isValidPublicKey(r.publicKey)) return null;
  if (typeof r.secretKey !== "string") return null;
  try {
    if (Buffer.from(r.secretKey, "base64").length !== 32) return null;
  } catch {
    return null;
  }
  return { publicKey: r.publicKey, secretKey: r.secretKey };
}

function validateDevices(data: unknown): PairedDevice[] | null {
  if (!Array.isArray(data)) return null;
  for (const d of data) {
    if (!d || typeof d !== "object") return null;
    const r = d as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.name !== "string") return null;
    if (!isValidPublicKey(r.publicKey)) return null;
    if (typeof r.pairedAt !== "number") return null;
  }
  return data as PairedDevice[];
}

function parsePairHelloInner(plain: string): PairHelloInner | null {
  try {
    const data = JSON.parse(plain) as Record<string, unknown>;
    if (!isValidPublicKey(data.publicKey)) return null;
    const name = typeof data.name === "string" ? data.name.slice(0, 100) : "";
    return { publicKey: data.publicKey, name };
  } catch {
    return null;
  }
}

/** 原子写 + 0600（凭证类文件）：tmp 同目录 rename，权限钉死在 tmp 与终态两处 */
function atomicWritePrivate(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

/** 设备指纹：公钥 sha256 前 8 位 hex（桌面/手机双向人工核对用，类似 SSH fingerprint） */
export function deviceFingerprint(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 8);
}

export class PairingManager {
  private readonly dir: string;
  private readonly keyFile: string;
  private readonly devicesFile: string;
  private readonly now: () => number;
  private identity: BoxKeyPairB64 | null = null;
  private deviceList: PairedDevice[] | null = null;
  private window: PairingWindow | null = null;
  private failures = 0;
  private lockedUntil = 0;

  constructor(opts: { baseDir?: string; now?: () => number } = {}) {
    this.dir = join(opts.baseDir ?? resolveSpcodeHome(), "remote");
    this.keyFile = join(this.dir, "device.key");
    this.devicesFile = join(this.dir, "devices.json");
    this.now = opts.now ?? (() => Date.now());
  }

  /** 桌面长期设备密钥对：不存在则生成并 0600 落盘 */
  getIdentity(): BoxKeyPairB64 {
    if (this.identity) return this.identity;
    mkdirSync(this.dir, { recursive: true });
    const loaded = readJsonFile(this.keyFile, validateIdentity);
    if (loaded) {
      this.identity = loaded;
      return loaded;
    }
    const kp = generateBoxKeyPair();
    atomicWritePrivate(this.keyFile, JSON.stringify(kp, null, 2));
    this.identity = kp;
    return kp;
  }

  devices(): PairedDevice[] {
    if (this.deviceList) return this.deviceList;
    this.deviceList = readJsonFile(this.devicesFile, validateDevices) ?? [];
    return this.deviceList;
  }

  findByPublicKey(publicKey: string): PairedDevice | undefined {
    return this.devices().find((d) => d.publicKey === publicKey);
  }

  /** 设备级入站 seq 基准线（协议 v2 防跨连接重放）：缺省 -1（没见过任何帧） */
  lastInSeqOf(publicKey: string): number {
    return this.findByPublicKey(publicKey)?.lastInSeq ?? -1;
  }

  /**
   * 更新设备的入站 seq 基准线。persist=false 只改内存（每帧调用不刷盘）；
   * persist=true（每 32 帧与连接关闭时）才落盘——崩溃丢失的部分只会让基准线偏低，
   * 不会放大重放窗口（对端持久化自己的出站 seq，双方取 max 续接）。
   */
  noteInboundSeq(publicKey: string, seq: number, persist: boolean): void {
    const dev = this.findByPublicKey(publicKey);
    if (!dev || seq <= (dev.lastInSeq ?? -1)) return;
    dev.lastInSeq = seq;
    if (persist) this.persistDevices();
  }

  removeDevice(id: string): boolean {
    const list = this.devices();
    const idx = list.findIndex((d) => d.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    this.persistDevices();
    return true;
  }

  /** 开启一次新的配对窗口（重置错误计数；旧窗口作废） */
  beginPairing(): PairingWindow {
    this.window = { otp: generateOtp(), expiresAt: this.now() + OTP_TTL_MS };
    this.failures = 0;
    return this.window;
  }

  /** 当前有效窗口（过期即作废） */
  currentPairing(): PairingWindow | null {
    if (!this.window) return null;
    if (this.now() >= this.window.expiresAt) {
      this.window = null;
      return null;
    }
    return this.window;
  }

  lockedRemainingMs(): number {
    return Math.max(0, this.lockedUntil - this.now());
  }

  /**
   * OTP 握手（协议 v2）：pair 帧只带 secretbox 密文，OTP 不上线。
   * 用当前窗口 OTP 派生密钥直接试解——解不开即 OTP 不匹配（计数锁定）；
   * 成功即消费窗口（单次有效），同公钥重复配对替换旧记录。
   */
  tryPair(ciphertext: string): PairResult {
    const now = this.now();
    if (now < this.lockedUntil) return { ok: false, error: "locked" };
    const win = this.currentPairing();
    if (!win) return { ok: false, error: "expired" };
    const plain = secretboxDecrypt(ciphertext, deriveOtpKey(win.otp));
    const inner = plain ? parsePairHelloInner(plain) : null;
    if (!plain || !inner) {
      // 解密失败与解析失败同归 otp_mismatch：没有 OTP 的一方无法区分两者，统一计数防试探
      this.failures += 1;
      if (this.failures >= MAX_OTP_FAILURES) {
        this.lockedUntil = now + LOCKOUT_MS;
        this.window = null;
        this.failures = 0;
      }
      return { ok: false, error: plain ? "bad_payload" : "otp_mismatch" };
    }

    // 单次有效：成功后立即关闭窗口
    this.window = null;
    this.failures = 0;

    const device: PairedDevice = {
      id: randomUUID(),
      name: inner.name || "未命名设备",
      publicKey: inner.publicKey,
      pairedAt: now,
    };
    const list = this.devices();
    const idx = list.findIndex((d) => d.publicKey === device.publicKey);
    if (idx >= 0) list[idx] = device;
    else list.push(device);
    this.persistDevices();
    return { ok: true, device };
  }

  /**
   * QR payload（协议 v2）：
   *   spcode-remote://pair?v=2&hosts=<逗号分隔,URL编码>&desktop_pk=<base64>&otp=<8位>
   */
  buildQrPayload(urls: string[], win: PairingWindow): string {
    const hosts = encodeURIComponent(urls.join(","));
    const pk = encodeURIComponent(this.getIdentity().publicKey);
    return `spcode-remote://pair?v=2&hosts=${hosts}&desktop_pk=${pk}&otp=${win.otp}`;
  }

  private persistDevices(): void {
    mkdirSync(this.dir, { recursive: true });
    atomicWritePrivate(this.devicesFile, JSON.stringify(this.deviceList, null, 2));
  }
}
