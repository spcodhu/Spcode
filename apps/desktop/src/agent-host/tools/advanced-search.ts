/**
 * AdvancedSearch —— 用户配置了搜索 API（Tavily / 博查 / 自定义）后注册的高级搜索工具。
 *
 * 与 WebSearch（抓 Bing 结果页，零配置兜底）的关系：
 * WebSearch 永远在；本工具仅在配置完整时出现在工具列表里（session-controller 门控），
 * description 里引导模型在「多信息源交叉验证 / 高精度 / 强时效」场景优先用它。
 * 协议适配与执行逻辑在 @spcode/shared/advanced-search（设置页校验、主进程测试连接共用）。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AdvancedSearchConfig } from "@spcode/shared";
import { executeSearch, isAdvancedSearchReady } from "@spcode/shared/advanced-search";
import { type Static, Type } from "typebox";

const schema = Type.Object({
  query: Type.String({ description: "Search query (natural language, in any script)" }),
  numResults: Type.Optional(Type.Number({ description: "Number of results to return (default 10, max 20)" })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 20)" })),
});

type Params = Static<typeof schema>;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function createAdvancedSearchTool(getConfig: () => AdvancedSearchConfig | null): ToolDefinition {
  return {
    name: "AdvancedSearch",
    label: "Advanced Search",
    description:
      "Run a high-quality web search via the configured search API (multi-source, higher precision than WebSearch). Prefer this tool over WebSearch when the query needs cross-source verification, high accuracy, or fresh/time-sensitive information; use WebSearch for casual lookups. Returns titles, URLs and snippets; call WebFetch on the best hit to read the full article.",
    promptSnippet:
      "High-precision multi-source search API; prefer over WebSearch for cross-source or time-sensitive queries",
    parameters: schema,
    execute: async (_id, args: Params, signal) => {
      const query = (args.query ?? "").trim();
      if (!query) {
        return { content: [{ type: "text", text: "Missing query" }], details: undefined, isError: true };
      }
      // 工具只在配置完整时注册；这里再查一次兜底（配置可能在会话存活期间被清空）
      const config = getConfig();
      if (!config || !isAdvancedSearchReady(config)) {
        return {
          content: [
            {
              type: "text",
              text: "AdvancedSearch is not configured (missing baseUrl/apiKey). Fall back to WebSearch.",
            },
          ],
          details: undefined,
          isError: true,
        };
      }
      const numResults = clamp(Number(args.numResults ?? 10), 1, 20);
      const timeoutMs = clamp(Number(args.timeout ?? 20) * 1000, 5000, 60000);
      try {
        const results = await executeSearch(config, query, numResults, timeoutMs, signal);
        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No results for: "${query}". Try rephrasing the query, or fall back to WebSearch.`,
              },
            ],
            details: undefined,
          };
        }
        const text = [
          `Advanced search: ${query} (${results.length} results)`,
          "",
          ...results.map(
            (r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet.slice(0, 200)}` : ""}`,
          ),
        ].join("\n");
        return { content: [{ type: "text", text }], details: { results } };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `AdvancedSearch failed: ${err instanceof Error ? err.message : String(err)}. Consider falling back to WebSearch.`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }
    },
  };
}
