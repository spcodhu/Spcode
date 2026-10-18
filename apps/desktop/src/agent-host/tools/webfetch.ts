/**
 * WebFetch —— 抓取公开 URL → 整页 Turndown 转 Markdown → 按 prompt 保留相关段落。
 * 与 Finch 的抓取实现同路线：整页转换（不猜 main/article 结构）、
 * 段落级相关性筛选（命中度 top12 + 首尾段保底）、超限按段落截断并标注省略量。
 * 结果缓存 5 分钟，避免重复抓取浪费 token。
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import TurndownService from "turndown";
import { type Static, Type } from "typebox";
import { fetchPublic } from "./ssrf.js";

const schema = Type.Object({
  url: Type.String({ description: "Absolute URL to fetch (http/https only)" }),
  prompt: Type.Optional(
    Type.String({ description: "What you are looking for; used to keep the most relevant sections" }),
  ),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 30)" })),
});

type Params = Static<typeof schema>;

const MAX_CHARS = 24000;
const CACHE_TTL = 5 * 60 * 1000;

interface PageData {
  at: number;
  title?: string;
  contentType: string;
  fullText: string;
}

const cache = new Map<string, PageData>();
const CACHE_MAX = 200;

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
turndown.remove(["script", "style", "noscript", "iframe", "svg", "form", "nav", "footer"] as unknown as never);

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m?.[1]?.trim() || undefined;
}

/** 行级空白归一：压平行内空格、去空行 */
function normalizeLines(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

/**
 * 按 prompt 关键词保留相关段落：命中度 top12 + 首尾段保底，保持原顺序。
 * 段落数 ≤12 或无命中时返回全文（宁可多给也不少给）。导出供单测使用。
 */
export function filterByPrompt(markdown: string, prompt: string): string {
  const paragraphs = markdown
    .split(/\n{2,}|(?<=[.。!?！？])\s+(?=\S)/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length <= 12) return markdown;
  const terms = prompt
    .toLowerCase()
    .split(/[\s,，.。;；:：!！?？()（）[\]【】"'`]+/)
    .filter((w) => w.length >= 2);
  if (terms.length === 0) return markdown;
  const scored = paragraphs
    .map((p, idx) => {
      const lower = p.toLowerCase();
      let score = 0;
      for (const t of terms) if (lower.includes(t)) score++;
      return { idx, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
  if (scored.length === 0) return markdown;
  // 首尾段通常是结论/摘要，保底保留
  const keep = new Set<number>([0, 1, paragraphs.length - 1]);
  for (const s of scored) keep.add(s.idx);
  return [...keep]
    .sort((a, b) => a - b)
    .map((i) => paragraphs[i])
    .join("\n\n");
}

/** 按段落边界截断，并标注省略量（模型可见，知道还有内容没读）。导出供单测使用 */
export function truncateWithNotice(text: string, max: number): string {
  if (text.length <= max) return text;
  const paragraphs = text.split(/\n{2,}/);
  let out = "";
  for (const p of paragraphs) {
    if (`${out}\n\n${p}`.length > max) break;
    out = out ? `${out}\n\n${p}` : p;
  }
  if (!out) out = text.slice(0, max);
  return `${out}\n\n[Output truncated: ${text.length - out.length} chars omitted]`;
}

function cacheGet(url: string): PageData | undefined {
  const hit = cache.get(url);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(url);
    return undefined;
  }
  // LRU：命中即移到末尾
  cache.delete(url);
  cache.set(url, hit);
  return hit;
}

function cacheSet(url: string, data: PageData): void {
  cache.set(url, data);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function fetchPage(url: string, timeoutMs: number, signal?: AbortSignal): Promise<PageData> {
  // 评审 R3-C7：SSRF 防护 + 响应体上限都在 fetchPublic 里（私网/回环/metadata 拦截、
  // 重定向逐跳复检、流式 2MB 上限、内容类型白名单）
  const res = await fetchPublic(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    timeoutMs,
    signal,
  });
  const contentType = res.contentType;
  const body = res.body;
  if (!contentType.includes("html")) {
    return {
      at: Date.now(),
      contentType: contentType || "unknown",
      fullText: normalizeLines(body.slice(0, MAX_CHARS * 2)),
    };
  }
  // 整页转 Markdown：不猜 main/article 容器， Turndown 已剔除 script/style/nav/footer
  let md: string;
  try {
    md = turndown.turndown(body);
  } catch {
    md = body.replace(/<[^>]+>/g, " ");
  }
  return {
    at: Date.now(),
    title: extractTitle(body),
    contentType: contentType || "unknown",
    fullText: normalizeLines(md.replace(/\n{3,}/g, "\n\n").trim()),
  };
}

export function createWebFetchTool(): ToolDefinition {
  return {
    name: "WebFetch",
    label: "Web Fetch",
    description:
      "Fetch a public URL and return its main article text converted to Markdown. Supports an optional prompt to keep only the most relevant sections. Results are cached for 5 minutes. Use after WebSearch to read the full article.",
    promptSnippet: "Fetch a URL and convert to Markdown (5-min cache)",
    parameters: schema,
    execute: async (_id, args: Params, signal) => {
      const url = (args.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) {
        return {
          content: [{ type: "text", text: "Invalid URL (http/https only)" }],
          details: undefined,
          isError: true,
        };
      }
      const timeoutMs = clamp(Number(args.timeout ?? 30) * 1000, 5000, 90000);
      try {
        const cached = cacheGet(url);
        const page = cached ?? (await fetchPage(url, timeoutMs, signal));
        if (!cached) cacheSet(url, page);

        const prompt = (args.prompt ?? "").trim();
        const filtered = prompt ? filterByPrompt(page.fullText, prompt) : page.fullText;
        const content = truncateWithNotice(filtered, MAX_CHARS);
        if (!content.trim()) {
          return {
            content: [{ type: "text", text: "Fetched page but extracted no readable text." }],
            details: undefined,
          };
        }
        // 信封头：来源/标题/长度，方便模型引用与判断是否被截断
        const header = [
          `URL: ${url}`,
          page.title ? `Title: ${page.title}` : undefined,
          `Content-Type: ${page.contentType}`,
          `Length: ${content.length} chars${prompt && filtered.length < page.fullText.length ? " [filtered by prompt]" : ""}${cached ? " [cached]" : ""}`,
        ]
          .filter((l): l is string => l !== undefined)
          .join("\n");
        return { content: [{ type: "text", text: `${header}\n\n${content}` }], details: { url } };
      } catch (err) {
        return {
          content: [{ type: "text", text: `WebFetch failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
          isError: true,
        };
      }
    },
  };
}
