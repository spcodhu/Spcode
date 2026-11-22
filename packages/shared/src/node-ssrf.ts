/**
 * Node 执行端共享的 SSRF 基础校验：静态主机/IP 拦截 + DNS 解析后校验。
 * 浏览器渲染层不导入本模块；image-gen 通过注入 guard 复用此能力。
 */
import { lookup } from "node:dns/promises";

/** 字面/解析后 IP 是否私网/保留段（IPv4 + IPv6） */
export function isPrivateIp(ip: string): boolean {
  let v = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, ""); // URL.hostname 的 IPv6 带方括号
  // IPv4-mapped IPv6：URL 会把点分后缀规范化为两个十六进制 hextet。
  if (v.startsWith("::ffff:")) {
    const mapped = v.slice(7);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
    if (hex) {
      const high = Number.parseInt(hex[1] as string, 16);
      const low = Number.parseInt(hex[2] as string, 16);
      v = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    } else {
      v = mapped;
    }
  }
  if (v === "0" || v === "0.0.0.0" || v === "::" || v === "::1") return true;
  if (v.includes(":")) {
    // IPv6：fc00::/7（ULA）、fe80::/10（link-local）、fec0::/10（废弃站点本地）
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  const parts = v.split(".");
  if (parts.length !== 4) return false; // 非点分四段 → 主机名检查兜底
  const a = Number.parseInt(parts[0] ?? "", 10);
  const b = Number.parseInt(parts[1] ?? "", 10);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local（含云 metadata）
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0/24（IETF 保留）
    a >= 224 // 组播/保留/240/4
  );
}

/** 主机名是否指向本机/私网（含十进制/十六进制 IPv4 变体） */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "metadata.google.internal") return true;
  if (isPrivateIp(h)) return true;
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) {
    const n = Number(h);
    if (Number.isFinite(n)) {
      const a = (n >>> 24) & 255;
      const b = (n >>> 16) & 255;
      if (isPrivateIp(`${a}.${b}.${(n >>> 8) & 255}.${n & 255}`)) return true;
    }
  }
  return false;
}

export type PublicUrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/** 校验公网 HTTP(S) URL；DNS 失败按拒绝处理（fail-closed）。 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<PublicUrlCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "The URL could not be parsed" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Only http/https URLs are allowed" };
  }
  if (url.username || url.password) return { ok: false, reason: "Embedded credentials are not allowed" };
  const host = url.hostname;
  if (isPrivateHost(host)) {
    return { ok: false, reason: `Target ${host} is a local/private/reserved address; blocked by SSRF protection` };
  }
  // 字面 IP 公网 → 直接过；域名 → DNS 解析后校验
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host) && !host.includes(":")) {
    try {
      const addrs = await lookup(host, { all: true });
      if (addrs.length === 0) return { ok: false, reason: `Domain ${host} did not resolve` };
      for (const a of addrs) {
        if (isPrivateIp(a.address)) {
          return {
            ok: false,
            reason: `Domain ${host} resolves to private address ${a.address}; blocked by SSRF protection`,
          };
        }
      }
    } catch (err) {
      return {
        ok: false,
        reason: `Domain ${host} failed to resolve: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { ok: true, url: url.href };
}
