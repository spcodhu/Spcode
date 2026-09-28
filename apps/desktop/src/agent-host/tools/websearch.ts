/**
 * WebSearch —— 直抓 Bing 搜索结果页 HTML 并解析（ Finch 同款路线）。
 * 与模型解耦、零密钥；解析失败降级为空列表+提示，绝不炸流。
 */
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const schema = Type.Object({
  query: Type.String({ description: "Search query (natural language, in any script)" }),
  numResults: Type.Optional(Type.Number({ description: "Number of results to return (default 10, max 10)" })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 20)" })),
});

type Params = Static<typeof schema>;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
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
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept-Language": lang,
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Bing returned HTTP ${res.status}`);
    const html = await res.text();
    return parseResults(html);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Bing 结果页解析：<li class="b_algo"> 块里取 <h2><a href> 与摘要 */
function parseResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<li class="b_algo[^"]*"/).slice(1);
  for (const block of blocks) {
    const end = block.indexOf("</li>");
    const seg = end > 0 ? block.slice(0, end) : block;
    const linkMatch = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(seg);
    if (!linkMatch) continue;
    const url = decodeEntities(linkMatch[1] ?? "");
    const title = decodeEntities(stripTags(linkMatch[2] ?? "")).trim();
    const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/.exec(seg);
    const snippet = snippetMatch ? decodeEntities(stripTags(snippetMatch[1] ?? "")).trim() : "";
    if (url && title) results.push({ title, url, snippet });
    if (results.length >= 10) break;
  }
  return results;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
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
          return {
            content: [
              {
                type: "text",
                text: `No results parsed for "${query}". Bing page structure may have changed; try rephrasing the query.`,
              },
            ],
            details: undefined,
          };
        }
        const text = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
          .join("\n\n");
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
