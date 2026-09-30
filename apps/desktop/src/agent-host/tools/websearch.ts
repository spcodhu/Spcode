/**
 * WebSearch —— 抓 Bing 结果页 → Turndown 转 Markdown → 从标题链接解析结果。
 * 与 Finch 的搜索实现同路线：不依赖 b_algo 等 DOM 类名，抗 Bing 版式变化；
 * 同时解码 Bing 跳转链接（…/ck/a?…&u=a1<base64>）拿到真实 URL，
 * 让模型后续 WebFetch 直达原文而不是撞上跳转页。
 * 与模型解耦、零密钥；失败降级为提示文本，绝不炸流。
 */
import TurndownService from "turndown";
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const schema = Type.Object({
  query: Type.String({ description: "Search query (natural language, in any script)" }),
  numResults: Type.Optional(Type.Number({ description: "Number of results to return (default 10, max 10)" })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 20)" })),
});

type Params = Static<typeof schema>;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

let turndown: TurndownService | null = null;
function getTurndown(): TurndownService {
  return (turndown ??= new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Turndown 后的结果页 Markdown → 结构化结果（导出供单测）。
 * 原理：Turndown 把 <h2><a href="…">标题</a></h2> 转成 `## [标题](url)`，
 * 一条正则扫出所有结果，再清洗/去重/解码跳转。
 */
export function parseSearchMarkdown(markdown: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const HEADING_LINK = /^\s*#{1,6}\s+\[([^\]]{3,})\]\((https?:\/\/[^)]+)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = HEADING_LINK.exec(markdown)) !== null) {
    const rawUrl = (m[2] ?? "").trim();
    const url = decodeBingRedirect(rawUrl) ?? rawUrl;
    if (!/^https?:\/\//i.test(url)) continue;
    // 跳过必应/微软自家链接（导航、"图片"、"视频"标签页等；含子域名）
    if (/[/.]bing\.com[/?]|[/.]microsoft\.com[/?]/i.test(url)) continue;
    const title = cleanInline(m[1] ?? "");
    if (title.length < 5) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const rest = markdown.slice(m.index + m[0].length);
    const snippet = cleanInline(leadingBlock(rest)).slice(0, 200);
    results.push({ title, url, snippet });
    if (results.length >= limit) break;
  }
  return results;
}

/** Bing 跳转链接解码：…/ck/a?…&u=a1<base64url（真实 URL）> */
export function decodeBingRedirect(url: string): string | undefined {
  const m = /[?&]u=a1([A-Za-z0-9+/=_-]+)/.exec(url);
  if (!m || !m[1]) return undefined;
  try {
    const decoded = Buffer.from(m[1], "base64").toString("utf-8");
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch {
    // 不是合法 base64 → 当普通链接处理
  }
  return undefined;
}

/** 取标题之后、下一个链接/标题/有序列表之前的文本块，作为摘要原料 */
function leadingBlock(text: string): string {
  const t = text.replace(/^\s*\n*/, "");
  const end = t.search(/\n\s*\[|\n#{1,6}\s|\n\s*\d+\.\s+\[/);
  return (end >= 0 ? t.slice(0, end) : t.slice(0, 250)).trim();
}

/** 去掉行内 markdown 标记（加粗/斜体/行内代码）并压平空白 */
function cleanInline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchBing(query: string, timeoutMs: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const isCJK = CJK.test(query);
  const ensearch = isCJK ? "" : "&ensearch=1";
  const lang = isCJK ? "zh-CN,zh;q=0.9,en;q=0.8" : "en-US,en;q=0.9";
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}${ensearch}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": lang,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Bing returned HTTP ${res.status}`);
    const html = await res.text();
    // 整页转 Markdown 再解析：标题链接即搜索结果，天然免疫 DOM 类名变化
    const markdown = getTurndown().turndown(html);
    return parseSearchMarkdown(markdown, 10);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export function createWebSearchTool(): ToolDefinition {
  return {
    name: "WebSearch",
    label: "Web Search",
    description:
      "Run a web search via Bing and return up to 10 results with short snippets. Pick one result and call WebFetch to read the full article. Use when the answer depends on current/external knowledge.",
    promptSnippet: "Search the web via Bing (titles + snippets), then WebFetch the best hit",
    parameters: schema,
    execute: async (_id, args: Params, signal) => {
      const query = (args.query ?? "").trim();
      if (!query) {
        return { content: [{ type: "text", text: "Missing query" }], details: undefined, isError: true };
      }
      const numResults = clamp(Number(args.numResults ?? 10), 1, 10);
      const timeoutMs = clamp(Number(args.timeout ?? 20) * 1000, 5000, 60000);
      try {
        const results = (await searchBing(query, timeoutMs, signal)).slice(0, numResults);
        if (results.length === 0) {
          // 非错误：引导模型换个问法重试，而不是当作工具故障
          return {
            content: [
              {
                type: "text",
                text: `No results for: "${query}". Try rephrasing the query with different keywords.`,
              },
            ],
            details: undefined,
          };
        }
        const text = [
          `Search: ${query} (${results.length} results)`,
          "",
          ...results.map(
            (r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet.slice(0, 120)}` : ""}`,
          ),
        ].join("\n");
        return { content: [{ type: "text", text }], details: { results } };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `WebSearch failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }
    },
  };
}
