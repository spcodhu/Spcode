/**
 * 远程控制加密层（双端同构：桌面 Node / 移动浏览器 / 任意 JS 运行时行为一致）。
 *
 * 评审 R3-C12：这份实现曾是 desktop main/remote/crypto.ts 与 mobile lib/crypto.ts 的
 * 平行双份，已开始分叉（SeqCounter.reset 只有一端有）。wire 格式双端各维护是
 * 互通定时炸弹——现统一收敛到这里，跨端一致性由测试向量锁定（mobile/test/crypto.test.ts）。
 *
 * 本文件自包含（不 import 本包其他文件）：shared 在桌面主进程以 TS 源码被 Node
 * 直接加载，运行时相对导入会解析失败（见 node.ts 头注）。
 *
 * 包含：base64（纯 JS）、sha256（纯 JS 同步）、OTP KDF、NaCl box/secretbox、
 * SeqGuard/SeqCounter、OTP 生成、channelId 推导。
 */
import nacl from "tweetnacl";

// ---------------------------------------------------------------------------
// base64（纯 JS，无 Buffer/atob 依赖）
// ---------------------------------------------------------------------------

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

export function b64encode(buf: Uint8Array): string {
  let out = "";
  for (let i = 0; i < buf.length; i += 3) {
    const a = buf[i]!;
    const b = i + 1 < buf.length ? buf[i + 1]! : 0;
    const c = i + 2 < buf.length ? buf[i + 2]! : 0;
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 0x03) << 4) | (b >> 4)];
    out += i + 1 < buf.length ? ALPHABET[((b & 0x0f) << 2) | (c >> 6)] : "=";
    out += i + 2 < buf.length ? ALPHABET[c & 0x3f] : "=";
  }
  return out;
}

export function b64decode(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0; // 未落盘的比特（始终 < 8 bit，不会溢出 32 位）
  let bits = 0;
  let o = 0;
  for (const ch of clean) {
    const v = LOOKUP.get(ch);
    if (v === undefined) throw new Error(`非法 base64 字符: ${ch}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  return out.subarray(0, o);
}

// ---------------------------------------------------------------------------
// SHA-256（纯 JS 同步；配对 KDF 需要确定性同步实现，不依赖 WebCrypto 安全上下文）
// ---------------------------------------------------------------------------

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** 纯 JS SHA-256（同步），输入任意字节，输出 32 字节摘要 */
export function sha256Sync(data: Uint8Array): Uint8Array {
  const bitLen = data.length * 8;
  // 预填充：末尾 0x80 + 补零 + 8 字节大端长度
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (h! + s1 + ch + K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (s0 + maj) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d! + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    h0 = (h0 + a!) >>> 0;
    h1 = (h1 + b!) >>> 0;
    h2 = (h2 + c!) >>> 0;
    h3 = (h3 + d!) >>> 0;
    h4 = (h4 + e!) >>> 0;
    h5 = (h5 + f!) >>> 0;
    h6 = (h6 + g!) >>> 0;
    h7 = (h7 + h!) >>> 0;
  }

  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (const [i, v] of [h0, h1, h2, h3, h4, h5, h6, h7].entries()) ov.setUint32(i * 4, v);
  return out;
}

export function sha256TextSync(text: string): Uint8Array {
  return sha256Sync(new TextEncoder().encode(text));
}

// ---------------------------------------------------------------------------
// 配对 OTP KDF（协议 v2）
// ---------------------------------------------------------------------------

/**
 * key = sha256 迭代 PAIR_KDF_ITERATIONS 轮，第 0 轮输入 `PAIR_KDF_DOMAIN + otp`，后续轮输入上一轮摘要。
 * 8 位 OTP 只有 10^8 空间，单轮 sha256 可被离线暴破；迭代拉高成本（评审 R3-C1）。
 */
export const PAIR_KDF_DOMAIN = "spcode-remote-pair-v2:";
export const PAIR_KDF_ITERATIONS = 50_000;

/** OTP → secretbox 密钥（同步纯 JS；5 万轮在移动端约几十毫秒） */
export function deriveOtpKey(otp: string): Uint8Array {
  let digest = sha256TextSync(`${PAIR_KDF_DOMAIN}${otp}`);
  for (let i = 1; i < PAIR_KDF_ITERATIONS; i++) {
    digest = sha256Sync(digest);
  }
  return digest;
}

// ---------------------------------------------------------------------------
// NaCl box / secretbox（密文布局：base64( nonce(24B) ‖ ciphertext )）
// ---------------------------------------------------------------------------

export interface BoxKeyPairB64 {
  publicKey: string;
  secretKey: string;
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

/** 生成 8 位数字 OTP（密码学随机 + 拒绝采样消除取模偏差，允许前导零） */
export function generateOtp(): string {
  for (;;) {
    const n = new DataView(nacl.randomBytes(4).buffer).getUint32(0);
    // 2^32 对 10^8 的最大整倍数是 4_200_000_000，超出即重抽（否则低位数字概率偏高）
    if (n < 4_200_000_000) return String(n % 100_000_000).padStart(8, "0");
  }
}

/** 接收侧 seq 防重放：只接受严格递增的整数 */
export class SeqGuard {
  private last = -1;

  accept(seq: unknown): boolean {
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq <= this.last) return false;
    this.last = seq;
    return true;
  }

  /** 协议 v2：用持久化的基准线初始化（重连不再归零，跨连接重放窗口随之关闭） */
  seed(last: number): void {
    this.last = last;
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

  /** 下一个将发出的 seq（持久化续接用） */
  peek(): number {
    return this.next;
  }

  /** 协议 v2：按 host 的 resumeSeq / 本地持久值续接出站序号 */
  setNext(n: number): void {
    if (Number.isInteger(n) && n >= 0) this.next = n;
  }

  reset(): void {
    this.next = 0;
  }
}

/** relay channelId = SHA-256(桌面 X25519 公钥原始 32 字节) 的 hex 小写 */
export function deriveChannelId(desktopPublicKeyB64: string): string {
  return [...sha256Sync(b64decode(desktopPublicKeyB64))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// 协议语义封装（hello 密文 / 加密业务帧的载荷）
// ---------------------------------------------------------------------------

import type { PairAckInner, PairHelloInner, RemoteEncryptedPayload } from "./index.js";

/** 配对握手：把手机公钥 + 设备名封进 OTP 派生密钥的 secretbox（pair hello 的 c 字段） */
export function pairSeal(inner: PairHelloInner, otp: string): string {
  return secretboxEncrypt(JSON.stringify(inner), deriveOtpKey(otp));
}

/** 解开 pair_ack 密文（桌面私钥 × 手机公钥的 box）；失败返回 null */
export function pairOpen(c: string, desktopPk: string, mySecretKey: string): PairAckInner | null {
  const plain = boxDecrypt(c, desktopPk, mySecretKey);
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
  return boxEncrypt(JSON.stringify(payload), peerPublicKey, mySecretKey);
}

export function openPayload(c: string, peerPublicKey: string, mySecretKey: string): RemoteEncryptedPayload | null {
  const plain = boxDecrypt(c, peerPublicKey, mySecretKey);
  if (!plain) return null;
  try {
    return JSON.parse(plain) as RemoteEncryptedPayload;
  } catch {
    return null;
  }
}
