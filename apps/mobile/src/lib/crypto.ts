/**
 * 远程控制加密层（手机侧，tweetnacl 封装）——与 apps/desktop/src/main/remote/crypto.ts 严格对齐：
 * - X25519 密钥对（NaCl box）
 * - 密文布局：base64( nonce(24B) ‖ ciphertext )，secretbox / box 同布局
 * - OTP 派生密钥：sha256("spcode-remote-pair-v1:" + otp)（WebCrypto 或纯 JS 兜底）
 * - seq：SeqCounter（发，0 起递增）/ SeqGuard（收，只收严格递增，防重放）
 */

import type { PairAckInner, PairHelloInner, RemoteEncryptedPayload } from "@spcode/shared";
import nacl from "tweetnacl";
import { b64decode, b64encode } from "./base64";
import { sha256Text } from "./sha256";

export interface KeyPairB64 {
  publicKey: string;
  secretKey: string;
}

/** 生成手机端 X25519 密钥对（base64） */
export function generateKeyPair(): KeyPairB64 {
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

/** OTP → secretbox 密钥（与桌面 deriveOtpKey 同式） */
export async function deriveOtpKey(otp: string): Promise<Uint8Array> {
  return sha256Text(`spcode-remote-pair-v1:${otp}`);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** secretbox 加密：base64( nonce ‖ ciphertext ) */
export function secretboxSeal(plaintext: string, key: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(encoder.encode(plaintext), nonce, key);
  return b64encode(concat(nonce, box));
}

/** secretbox 解密：任何失败（含篡改）一律返回 null，不抛错 */
export function secretboxOpen(payload: string, key: Uint8Array): string | null {
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

/** NaCl box 加密：base64( nonce ‖ ciphertext ) */
export function boxSeal(plaintext: string, peerPublicKey: string, mySecretKey: string): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const box = nacl.box(encoder.encode(plaintext), nonce, b64decode(peerPublicKey), b64decode(mySecretKey));
  return b64encode(concat(nonce, box));
}

/** NaCl box 解密：任何失败（含篡改/错密钥）一律返回 null，不抛错 */
export function boxOpen(payload: string, peerPublicKey: string, mySecretKey: string): string | null {
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

// ---------------------------------------------------------------------------
// 协议语义封装（hello 密文 / 加密业务帧的载荷）
// ---------------------------------------------------------------------------

/** 配对握手：把手机公钥 + 设备名封进 OTP 派生密钥的 secretbox（pair hello 的 c 字段） */
export async function pairSeal(inner: PairHelloInner, otp: string): Promise<string> {
  return secretboxSeal(JSON.stringify(inner), await deriveOtpKey(otp));
}

/** 解开 pair_ack 密文（桌面私钥 × 手机公钥的 box）；失败返回 null */
export function pairOpen(c: string, desktopPk: string, mySecretKey: string): PairAckInner | null {
  const plain = boxOpen(c, desktopPk, mySecretKey);
  if (!plain) return null;
  try {
    const inner = JSON.parse(plain) as PairAckInner;
    return typeof inner.desktopPk === "string" && typeof inner.deviceId === "string" ? inner : null;
  } catch {
    return null;
  }
}

/** 加密业务帧的载荷（command / event / response） */
export function sealPayload(payload: RemoteEncryptedPayload, peerPublicKey: string, mySecretKey: string): string {
  return boxSeal(JSON.stringify(payload), peerPublicKey, mySecretKey);
}

export function openPayload(c: string, peerPublicKey: string, mySecretKey: string): RemoteEncryptedPayload | null {
  const plain = boxOpen(c, peerPublicKey, mySecretKey);
  if (!plain) return null;
  try {
    return JSON.parse(plain) as RemoteEncryptedPayload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// seq（与桌面端 SeqGuard / SeqCounter 同语义）
// ---------------------------------------------------------------------------

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

  reset(): void {
    this.next = 0;
  }
}
