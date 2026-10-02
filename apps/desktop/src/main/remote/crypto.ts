/**
 * 远程控制加密层（tweetnacl 封装）：
 * - X25519 密钥对生成（NaCl box）
 * - box 加解密（nonce 随机，密文布局 nonce(24B) ‖ ciphertext，整体 base64）
 * - OTP 派生密钥的 secretbox（配对握手用）
 * - 每连接单调 seq：SeqGuard（收，防重放）/ SeqCounter（发）
 */

import { createHash, randomInt } from "node:crypto";
import nacl from "tweetnacl";

export interface BoxKeyPairB64 {
  publicKey: string;
  secretKey: string;
}

export function b64encode(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64");
}

export function b64decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

/** 生成 X25519 密钥对（base64 编码） */
export function generateBoxKeyPair(): BoxKeyPairB64 {
  const kp = nacl.box.keyPair();
  return { publicKey: b64encode(kp.publicKey), secretKey: b64encode(kp.secretKey) };
}

/** 校验字符串是否是合法的 32 字节 base64 公钥 */
export function isValidPublicKey(pk: unknown): pk is string {
  if (typeof pk !== "string" || !pk) return false;
  try {
    return b64decode(pk).length === nacl.box.publicKeyLength;
  } catch {
    return false;
  }
}

/**
 * OTP → secretbox 密钥：sha256("spcode-remote-pair-v1:" + otp)。
 * OTP 只走带外（桌面屏幕 QR/设置页），派生密钥不落地。
 */
export function deriveOtpKey(otp: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`spcode-remote-pair-v1:${otp}`).digest());
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** secretbox 加密：输出 base64( nonce ‖ ciphertext ) */
export function secretboxEncrypt(plaintext: string, key: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(encoder.encode(plaintext), nonce, key);
  return b64encode(concat(nonce, box));
}

/** secretbox 解密：任何失败（含篡改）一律返回 null，不抛错 */
export function secretboxDecrypt(payload: string, key: Uint8Array): string | null {
  try {
    const buf = b64decode(payload);
    if (buf.length <= nacl.secretbox.nonceLength) return null;
    const nonce = buf.subarray(0, nacl.secretbox.nonceLength);
    const box = buf.subarray(nacl.secretbox.nonceLength);
    const plain = nacl.secretbox.open(box, nonce, key);
    return plain ? decoder.decode(plain) : null;
  } catch {
    return null;
  }
}

/** NaCl box 加密：输出 base64( nonce ‖ ciphertext ) */
export function boxEncrypt(plaintext: string, peerPublicKey: string, mySecretKey: string): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const box = nacl.box(encoder.encode(plaintext), nonce, b64decode(peerPublicKey), b64decode(mySecretKey));
  return b64encode(concat(nonce, box));
}

/** NaCl box 解密：任何失败（含篡改/错密钥）一律返回 null，不抛错 */
export function boxDecrypt(payload: string, peerPublicKey: string, mySecretKey: string): string | null {
  try {
    const buf = b64decode(payload);
    if (buf.length <= nacl.box.nonceLength) return null;
    const nonce = buf.subarray(0, nacl.box.nonceLength);
    const box = buf.subarray(nacl.box.nonceLength);
    const plain = nacl.box.open(box, nonce, b64decode(peerPublicKey), b64decode(mySecretKey));
    return plain ? decoder.decode(plain) : null;
  } catch {
    return null;
  }
}

/** 生成 8 位数字 OTP（密码学随机，允许前导零） */
export function generateOtp(): string {
  return randomInt(0, 100_000_000).toString().padStart(8, "0");
}

/** 接收侧 seq 防重放：只接受严格递增的整数 */
export class SeqGuard {
  private last = -1;

  accept(seq: unknown): boolean {
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq <= this.last) return false;
    this.last = seq;
    return true;
  }

  reset(): void {
    this.last = -1;
  }
}

/** 发送侧 seq 计数：0 起单调递增 */
export class SeqCounter {
  private next = 0;

  take(): number {
    return this.next++;
  }
}
