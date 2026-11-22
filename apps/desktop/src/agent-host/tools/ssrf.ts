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
import { assertPublicHttpUrl } from "@spcode/shared/node-ssrf";

export type { PublicUrlCheck } from "@spcode/shared/node-ssrf";
export { assertPublicHttpUrl, isPrivateHost, isPrivateIp } from "@spcode/shared/node-ssrf";

/** 响应体硬上限（字节）：超大响应不再整读进内存 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** 重定向跳数上限 */
const MAX_REDIRECTS = 5;

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
