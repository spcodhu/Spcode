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
 * 包含：base64（纯 JS）、sha256（纯 JS 同步）、NaCl box、SeqGuard/SeqCounter、
 * OTP 生成、channelId 推导、配对/握手密文封装、relay 准入 MAC（协议 v3）。
 *
 * 协议 v3 安全审计：配对帧不再用 OTP 派生对称密钥（8 位 OTP 的 secretbox 可被在途 relay
 * 离线穷举后抢先配对），改为用 QR 带外下发的桌面公钥做 box——relay 看到的只是公钥密文，
 * OTP 只需抵御在线猜测（桌面 5 次锁定）。
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

/** HMAC-SHA256（纯 JS；relay 侧用 Node createHmac 等价实现，互通由测试向量锁定） */
export function hmacSha256Sync(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = 64;
  const k = new Uint8Array(block);
  k.set(key.length > block ? sha256Sync(key) : key);
  const ipad = new Uint8Array(block + message.length);
  const opad = new Uint8Array(block + 32);
  for (let i = 0; i < block; i++) {
    ipad[i] = k[i]! ^ 0x36;
    opad[i] = k[i]! ^ 0x5c;
  }
  ipad.set(message, block);
  opad.set(sha256Sync(ipad), block);
  return sha256Sync(opad);
}

/** 常数时间字节比较（长度不等直接 false） */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ---------------------------------------------------------------------------
// NaCl box（密文布局：base64( nonce(24B) ‖ ciphertext )）
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

/**
 * seq 上限：推到 MAX_SAFE_INTEGER 后 `+1` 不再递增，该设备会永久被拒；
 * 两端都在此封顶，超限视为非法帧。
 */
export const MAX_SEQ = Number.MAX_SAFE_INTEGER - 1;

function isValidSeq(seq: unknown): seq is number {
  return typeof seq === "number" && Number.isInteger(seq) && seq >= 0 && seq <= MAX_SEQ;
}

/** 接收侧 seq 防重放：只接受严格递增的整数 */
export class SeqGuard {
  private last = -1;

  accept(seq: unknown): boolean {
    if (!isValidSeq(seq) || seq <= this.last) return false;
    this.last = seq;
    return true;
  }

  /** 协议 v2：用持久化的基准线初始化（重连不再归零，跨连接重放窗口随之关闭） */
  seed(last: number): void {
    this.last = Number.isInteger(last) ? Math.min(Math.max(last, -1), MAX_SEQ) : -1;
  }

  reset(): void {
    this.last = -1;
  }
}

/** 发送侧 seq 计数：0 起单调递增 */
export class SeqCounter {
  private next = 0;

  take(): number {
    if (this.next > MAX_SEQ) throw new Error("seq exhausted");
    return this.next++;
  }

  /** 下一个将发出的 seq（持久化续接用） */
  peek(): number {
    return this.next;
  }

  /** 协议 v2：按 host 的 resumeSeq / 本地持久值续接出站序号 */
  setNext(n: number): void {
    if (isValidSeq(n)) this.next = n;
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

import type {
  AuthAckInner,
  HelloErrorInner,
  PairAckInner,
  PairHelloInner,
  RelayDeviceGrant,
  RemoteEncryptedPayload,
} from "./index.js";

/** 通用：JSON 对象 box 加密 */
export function sealJson(value: unknown, peerPublicKey: string, mySecretKey: string): string {
  return boxEncrypt(JSON.stringify(value), peerPublicKey, mySecretKey);
}

/** 通用：box 解密 + JSON 解析 + 形状校验；任何失败返回 null */
export function openJson<T>(
  c: string,
  peerPublicKey: string,
  mySecretKey: string,
  guard: (value: unknown) => value is T,
): T | null {
  const plain = boxDecrypt(c, peerPublicKey, mySecretKey);
  if (!plain) return null;
  try {
    const value: unknown = JSON.parse(plain);
    return guard(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export function isRelayDeviceGrant(value: unknown): value is RelayDeviceGrant {
  return (
    isRecord(value) &&
    typeof value.exp === "number" &&
    Number.isInteger(value.exp) &&
    typeof value.mac === "string" &&
    value.mac.length > 0
  );
}

function isPairHelloInner(value: unknown): value is PairHelloInner {
  return isRecord(value) && value.v === 3 && typeof value.otp === "string" && typeof value.name === "string";
}

function isPairAckInner(value: unknown): value is PairAckInner {
  return (
    isRecord(value) &&
    typeof value.desktopPk === "string" &&
    typeof value.deviceId === "string" &&
    (value.relayGrant === undefined || isRelayDeviceGrant(value.relayGrant))
  );
}

function isAuthAckInner(value: unknown): value is AuthAckInner {
  return (
    isRecord(value) &&
    typeof value.desktopPk === "string" &&
    typeof value.resumeSeq === "number" &&
    (value.relayGrant === undefined || isRelayDeviceGrant(value.relayGrant))
  );
}

function isHelloErrorInner(value: unknown): value is HelloErrorInner {
  return isRecord(value) && typeof value.error === "string";
}

/**
 * 配对握手（协议 v3）：手机把 OTP + 设备名封进「桌面公钥 × 手机临时私钥」的 box。
 * 桌面公钥来自 QR（带外可信），relay 无法离线穷举 OTP，也无法替换手机公钥（ECDH 绑定）。
 */
export function sealPairHello(inner: Omit<PairHelloInner, "v">, desktopPk: string, mySecretKey: string): string {
  return sealJson({ v: 3, ...inner } satisfies PairHelloInner, desktopPk, mySecretKey);
}

/** 桌面解开 pair 帧密文（手机外层公钥 × 桌面私钥）；失败返回 null。OTP 比对由调用方做 */
export function openPairHello(c: string, devicePk: string, desktopSecretKey: string): PairHelloInner | null {
  return openJson(c, devicePk, desktopSecretKey, isPairHelloInner);
}

/** 解开 pair_ack 成功密文（桌面私钥 × 手机公钥的 box）；失败返回 null */
export function pairOpen(c: string, desktopPk: string, mySecretKey: string): PairAckInner | null {
  return openJson(c, desktopPk, mySecretKey, isPairAckInner);
}

/** 解开 auth_ack 成功密文 */
export function openAuthAck(c: string, desktopPk: string, mySecretKey: string): AuthAckInner | null {
  return openJson(c, desktopPk, mySecretKey, isAuthAckInner);
}

/** 解开 pair_ack / auth_ack 失败密文（桌面对声明公钥加密的 {error}） */
export function openHelloError(c: string, desktopPk: string, mySecretKey: string): HelloErrorInner | null {
  return openJson(c, desktopPk, mySecretKey, isHelloErrorInner);
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

// ---------------------------------------------------------------------------
// relay 准入 MAC（协议 v3）：桌面与 relay 以 X25519 共享密钥（nacl.box.before）做 HMAC-SHA256，
// 证明「host 拥有 channel」与「device 持有桌面签发的准入令牌」。relay 侧同算法实现在
// spcod-relay/src/admission.ts，互通由共享测试向量锁定。
// ---------------------------------------------------------------------------

export const RELAY_HOST_PROOF_DOMAIN = "spcod-relay-host-v3:";
export const RELAY_DEVICE_GRANT_DOMAIN = "spcod-relay-device-v3:";
/** 配对令牌的主体（设备尚无 deviceId） */
export const RELAY_PAIR_SUBJECT = "pair";

function relaySharedKey(peerPublicKey: string, mySecretKey: string): Uint8Array {
  return nacl.box.before(b64decode(peerPublicKey), b64decode(mySecretKey));
}

function relayMac(message: string, sharedKey: Uint8Array): string {
  return b64encode(hmacSha256Sync(sharedKey, encoder.encode(message)));
}

function relayMacVerify(message: string, macB64: string, sharedKey: Uint8Array): boolean {
  try {
    return constantTimeEqual(b64decode(macB64), hmacSha256Sync(sharedKey, encoder.encode(message)));
  } catch {
    return false;
  }
}

export function hostProofMessage(channelId: string, ts: number): string {
  return `${RELAY_HOST_PROOF_DOMAIN}${channelId}:${ts}`;
}

export function deviceGrantMessage(channelId: string, subject: string, exp: number): string {
  return `${RELAY_DEVICE_GRANT_DOMAIN}${channelId}:${subject}:${exp}`;
}

/** host 取票证明：HMAC(`host-domain:channelId:ts`, X25519(relayPk, hostSk)) */
export function buildHostProof(channelId: string, ts: number, relayPk: string, hostSecretKey: string): string {
  return relayMac(hostProofMessage(channelId, ts), relaySharedKey(relayPk, hostSecretKey));
}

export function verifyHostProof(
  channelId: string,
  ts: number,
  proof: string,
  hostPk: string,
  relaySecretKey: string,
): boolean {
  return relayMacVerify(hostProofMessage(channelId, ts), proof, relaySharedKey(hostPk, relaySecretKey));
}

/** 设备准入令牌：桌面签发，subject = deviceId 或 RELAY_PAIR_SUBJECT */
export function buildDeviceGrant(
  channelId: string,
  subject: string,
  exp: number,
  relayPk: string,
  hostSecretKey: string,
): RelayDeviceGrant {
  return { exp, mac: relayMac(deviceGrantMessage(channelId, subject, exp), relaySharedKey(relayPk, hostSecretKey)) };
}

export function verifyDeviceGrant(
  channelId: string,
  subject: string,
  grant: RelayDeviceGrant,
  hostPk: string,
  relaySecretKey: string,
): boolean {
  return relayMacVerify(
    deviceGrantMessage(channelId, subject, grant.exp),
    grant.mac,
    relaySharedKey(hostPk, relaySecretKey),
  );
}

/** QR 里的紧凑串：`<exp>.<base64url mac>` */
export function encodeGrantParam(grant: RelayDeviceGrant): string {
  const url = grant.mac.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${grant.exp}.${url}`;
}

export function decodeGrantParam(text: string): RelayDeviceGrant | null {
  const dot = text.indexOf(".");
  if (dot <= 0) return null;
  const exp = Number(text.slice(0, dot));
  const url = text.slice(dot + 1);
  if (!Number.isInteger(exp) || exp <= 0 || !/^[A-Za-z0-9_-]+$/.test(url)) return null;
  let std = url.replace(/-/g, "+").replace(/_/g, "/");
  while (std.length % 4 !== 0) std += "=";
  return { exp, mac: std };
}
