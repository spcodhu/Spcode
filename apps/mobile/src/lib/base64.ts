/**
 * base64 工具：纯 JS 实现，浏览器 / Node / 非安全上下文（LAN http）下行为一致。
 * 与桌面端 apps/desktop/src/main/remote/crypto.ts 的 b64encode/b64decode 对齐。
 */

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
