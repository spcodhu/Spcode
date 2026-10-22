/**
 * SSRF 防护（评审 R3-C7）：agent-host 的 fetch 不在 OS 沙盒的网络边界内，
 * WebFetch/WebSearch 的 URL 由模型构造——必须挡住 localhost/私网/云 metadata。
 *
 * 两层：
 * 1. 主机名静态拦截：localhost 系、字面 IP（回环/私网/链路本地/CGNAT/保留段）、
 *    IPv6 ULA/link-local、IPv4-mapped IPv6；
 * 2. DNS 解析后校验：域名解析出的任一 IP 落在私网段即拒（防"公网域名指私网"）；
 *    解析与发起请求之间存在 TOCTOU 残差（DNS 重绑定需操作系统级钉扎，记录在案）。
 *
 * fetchPublic：manual 重定向逐跳复检 + content-length 预检 + 流式读取字节上限。
 */
import { lookup } from "node:dns/promises";

/** 响应体硬上限（字节）：超大响应不再整读进内存 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** 重定向跳数上限 */
const MAX_REDIRECTS = 5;

/** 字面/解析后 IP 是否私网/保留段（IPv4 + IPv6） */
export function isPrivateIp(ip: string): boolean {
  let v = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, ""); // URL.hostname 的 IPv6 带方括号
  // IPv4-mapped IPv6（::ffff:127.0.0.1）
  if (v.startsWith("::ffff:")) v = v.slice(7);
  if (v === "0" || v === "0.0.0.0" || v === "::" || v === "::1") return true;
  if (v.includes(":")) {
    // IPv6：fc00::/7（ULA）、fe80::/10（link-local）、fec0::/10（废弃站点本地）
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  const parts = v.split(".");
  if (parts.length !== 4) return false; // 非点分四段（可能是十进制/十六进制写法）→ 不在这判，主机名检查兜
  const a = Number.parseInt(parts[0] ?? "", 10);
  const b = Number.parseInt(parts[1] ?? "", 10);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local（含 169.254.169.254 云 metadata）
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0/24（IETF 保留，含 192.0.2 文档段）
    a >= 224 // 组播/保留/240/4
  );
}

/** 主机名是否指向本机/私网（静态部分；数字 IP 变体如 2130706433、0x7f000001 也拦） */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "metadata.google.internal") return true;
  if (isPrivateIp(h)) return true;
  // 十进制/十六进制 IPv4 变体（2130706433 = 0x7f000001 = 127.0.0.1）
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

/**
 * 校验 URL 可安全抓取（公网 http/https）。
 * 先静态主机名检查，再 DNS 解析校验；DNS 失败按拒绝处理（fail-closed）。
 */
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

/** 允许的响应内容类型（文本类；二进制/图片/音视频拒绝） */
const ALLOWED_CONTENT = /text\/|application\/(json|xml|xhtml|javascript|typescript|markdown|rss\+xml|atom\+xml)/i;

export interface FetchPublicOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  maxBytes?: number;
}

/**
 * 面向公网的安全抓取：URL 校验（含重定向逐跳复检）+ 内容类型白名单 +
 * content-length 预检 + 流式读取字节上限。任何一跳落在私网即拒绝。
 */
export async function fetchPublic(
  rawUrl: string,
  opts: FetchPublicOptions,
): Promise<{ url: string; status: number; contentType: string; body: string }> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await assertPublicHttpUrl(current);
    if (!check.ok) throw new Error(check.reason);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort);
    let res: Response;
    try {
      res = await fetch(check.url, {
        headers: opts.headers,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`HTTP ${res.status}（重定向无 Location）`);
      current = new URL(loc, check.url).href;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (contentType && !ALLOWED_CONTENT.test(contentType)) {
      throw new Error(`不支持的内容类型：${contentType.split(";")[0]}（仅允许文本类响应）`);
    }
    const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES;
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) {
      throw new Error(
        `响应体超限（声明 ${Math.round(declared / 1024 / 1024)}MB > 上限 ${Math.round(maxBytes / 1024 / 1024)}MB）`,
      );
    }

    // 流式读取 + 字节硬上限（content-length 可能缺失/撒谎）
    if (!res.body) {
      return { url: check.url, status: res.status, contentType, body: await res.text() };
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`响应体超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB，已截断读取`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return { url: check.url, status: res.status, contentType, body: new TextDecoder().decode(merged) };
  }
  throw new Error(`重定向超过 ${MAX_REDIRECTS} 跳`);
}
