/**
 * WebFetch —— 抓取公开 URL → HTML 转 Markdown → 按 prompt 过滤相关段落。
 * 结果缓存 5 分钟，避免重复抓取浪费 token。
 */
import TurndownService from "turndown";
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const schema = Type.Object({
  url: Type.String({ description: "Absolute URL to fetch (http/https only)" }),
  prompt: Type.Optional(Type.String({ description: "What you are looking for; used to keep the most relevant sections" })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 30)" })),
});

type Params = Static<typeof schema>;

const MAX_CHARS = 24000;
const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map<string, { at: number; markdown: string }>();

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
turndown.remove(["script", "style", "noscript", "iframe", "svg", "form", "nav", "footer"] as unknown as never);

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

async function fetchMarkdown(url: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.markdown;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    const body = await res.text();
    const markdown = contentType.includes("text/html") ? htmlToMarkdown(body) : body.slice(0, MAX_CHARS);
    cache.set(url, { at: Date.now(), markdown });
    // 缓存简单清理
    if (cache.size > 200) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
    return markdown;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function htmlToMarkdown(html: string): string {
  // 先粗取 main/article 区域，失败则全文
  const mainMatch =
    /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html) ?? /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html);
  const source = mainMatch?.[1] ?? html;
  let md: string;
  try {
    md = turndown.turndown(source);
  } catch {
    md = source.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  }
  return md.replace(/\n{3,}/g, "\n\n").trim();
}

/** 按 prompt 关键词保留相关段落（轻量启发式，不调用模型） */
function filterByPrompt(markdown: string, prompt: string): string {
  const keywords = prompt
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3)
    .slice(0, 12);
  if (keywords.length === 0 || markdown.length <= MAX_CHARS) return markdown.slice(0, MAX_CHARS);
  const paragraphs = markdown.split(/\n\n+/);
  const scored = paragraphs.map((p, i) => {
    const lower = p.toLowerCase();
    const hits = keywords.reduce((n, k) => n + (lower.includes(k) ? 1 : 0), 0);
    return { i, p, hits };
  });
  const kept = scored
    .filter((s) => s.hits > 0)
    .sort((a, b) => a.i - b.i)
    .map((s) => s.p)
    .join("\n\n");
  const result = kept.length > 400 ? kept : markdown;
  return result.slice(0, MAX_CHARS);
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
        return { content: [{ type: "text", text: "Invalid URL (http/https only)" }], details: undefined, isError: true };
      }
      const timeoutMs = clamp(Number(args.timeout ?? 30) * 1000, 5000, 90000);
      try {
        let markdown = await fetchMarkdown(url, timeoutMs, signal);
        if (args.prompt) markdown = filterByPrompt(markdown, args.prompt);
        if (!markdown.trim()) {
          return { content: [{ type: "text", text: "Fetched page but extracted no readable text." }], details: undefined };
        }
        return { content: [{ type: "text", text: markdown }], details: { url } };
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
