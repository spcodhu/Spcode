/**
 * AdvancedSearch 测试：协议解析/示例推断用离线夹具，
 * 工具端到端用 stub 的 fetch（不打真网，避免消耗用户 API 额度）。
 */
import type { AdvancedSearchConfig } from "@spcode/shared";
import { applyMapping, inferMapping, isAdvancedSearchReady, parseSearchResponse } from "@spcode/shared/advanced-search";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdvancedSearchTool } from "../src/agent-host/tools/advanced-search.js";

interface ToolResultLike {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

const TAVILY_CONFIG: AdvancedSearchConfig = {
  protocol: "tavily",
  baseUrl: "https://api.tavily.com/search",
  apiKey: "tvly-test",
};

const BOCHA_CONFIG: AdvancedSearchConfig = {
  protocol: "bocha",
  baseUrl: "https://api.bochaai.com/v1/web-search",
  apiKey: "sk-test",
};

describe("inferMapping（响应示例推断）", () => {
  it("识别嵌套的结果数组与字段（博查风格）", () => {
    const sample = JSON.stringify({
      code: 200,
      data: {
        webPages: {
          value: [
            { name: "标题一", url: "https://example.com/a", snippet: "摘要一" },
            { name: "标题二", url: "https://example.com/b", summary: "摘要二" },
          ],
        },
      },
    });
    const m = inferMapping(sample);
    expect(m).not.toBeNull();
    expect(m?.resultsPath).toBe("data.webPages.value");
    expect(m?.titleField).toBe("name");
    expect(m?.urlField).toBe("url");
    // snippet/summary 任一命中即可（合并前 3 个对象的键）
    expect(["snippet", "summary"]).toContain(m?.snippetField);
  });

  it("识别顶层就是数组的响应", () => {
    const sample = JSON.stringify([{ title: "t", link: "https://example.com/x", content: "c" }]);
    const m = inferMapping(sample);
    expect(m?.resultsPath).toBe("");
    expect(m?.urlField).toBe("link");
    expect(m?.titleField).toBe("title");
  });

  it("非法 JSON / 没有带 http 链接的数组 → null", () => {
    expect(inferMapping("not json")).toBeNull();
    expect(inferMapping(JSON.stringify({ results: [{ title: "t", url: "not-a-url" }] }))).toBeNull();
    expect(inferMapping(JSON.stringify({ foo: 1 }))).toBeNull();
  });
});

describe("applyMapping", () => {
  it("按映射提取并过滤无效 URL，空标题退回 URL", () => {
    const json = {
      data: {
        list: [
          { name: "有效", url: "https://a.com/1", summary: "s1" },
          { name: "坏链接", url: "javascript:x" },
          { url: "https://a.com/2" },
        ],
      },
    };
    const out = applyMapping(
      json,
      { resultsPath: "data.list", titleField: "name", urlField: "url", snippetField: "summary" },
      10,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ title: "有效", url: "https://a.com/1", snippet: "s1" });
    expect(out[1]?.title).toBe("https://a.com/2");
  });

  it("路径不存在 → 空数组而不是抛错", () => {
    expect(applyMapping({}, { resultsPath: "a.b.c", titleField: "t", urlField: "url", snippetField: "" }, 10)).toEqual(
      [],
    );
  });
});

describe("parseSearchResponse（预设协议）", () => {
  it("tavily：解析 results[]", () => {
    const out = parseSearchResponse(
      TAVILY_CONFIG,
      { results: [{ title: "T", url: "https://a.com", content: "C" }, { title: "无 URL" }] },
      10,
    );
    expect(out).toEqual([{ title: "T", url: "https://a.com", snippet: "C" }]);
  });

  it("bocha：code != 200 抛业务错误", () => {
    expect(() => parseSearchResponse(BOCHA_CONFIG, { code: 403, msg: "余额不足" }, 10)).toThrow("余额不足");
  });

  it("bocha：解析 data.webPages.value，summary 缺失退回 snippet", () => {
    const out = parseSearchResponse(
      BOCHA_CONFIG,
      {
        code: 200,
        data: {
          webPages: {
            value: [
              { name: "甲", url: "https://a.com/1", summary: "长摘要", snippet: "短" },
              { name: "乙", url: "https://a.com/2", snippet: "只有短摘要" },
            ],
          },
        },
      },
      10,
    );
    expect(out[0]?.snippet).toBe("长摘要");
    expect(out[1]?.snippet).toBe("只有短摘要");
  });

  it("custom：缺 mapping 抛错，有 mapping 按映射解析", () => {
    const noMapping: AdvancedSearchConfig = { ...TAVILY_CONFIG, protocol: "custom" };
    expect(() => parseSearchResponse(noMapping, {}, 10)).toThrow("映射");
    const mapping = inferMapping(JSON.stringify({ results: [{ title: "t", url: "https://a.com", content: "c" }] }));
    const cfg: AdvancedSearchConfig = { ...noMapping, mapping };
    const out = parseSearchResponse(cfg, { results: [{ title: "t", url: "https://a.com", content: "c" }] }, 10);
    expect(out).toEqual([{ title: "t", url: "https://a.com", snippet: "c" }]);
  });
});

describe("isAdvancedSearchReady（生效门控）", () => {
  it("缺 baseUrl/apiKey 不生效；custom 缺 mapping 不生效", () => {
    expect(isAdvancedSearchReady(null)).toBe(false);
    expect(isAdvancedSearchReady({ ...TAVILY_CONFIG, apiKey: " " })).toBe(false);
    expect(isAdvancedSearchReady(TAVILY_CONFIG)).toBe(true);
    expect(isAdvancedSearchReady({ protocol: "custom", baseUrl: "https://x.com", apiKey: "k" })).toBe(false);
    expect(
      isAdvancedSearchReady({
        protocol: "custom",
        baseUrl: "https://x.com",
        apiKey: "k",
        mapping: { resultsPath: "", titleField: "title", urlField: "url", snippetField: "" },
      }),
    ).toBe(true);
  });
});

describe("AdvancedSearch 工具（stub fetch）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function exec(
    tool: ReturnType<typeof createAdvancedSearchTool>,
    args: Record<string, unknown>,
  ): Promise<ToolResultLike> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await tool.execute("t1", args as any, undefined, undefined, {} as any)) as ToolResultLike;
  }

  it("未配置时返回错误并引导回退 WebSearch", async () => {
    const tool = createAdvancedSearchTool(() => null);
    const res = await exec(tool, { query: "test" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("WebSearch");
  });

  it("配置完整时请求带 Bearer 鉴权并格式化结果", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
      expect(init?.headers?.Authorization).toBe("Bearer tvly-test");
      expect(JSON.parse(init?.body ?? "{}").query).toBe("kimi");
      return new Response(
        JSON.stringify({ results: [{ title: "Kimi", url: "https://moonshot.cn", content: "AI 助手" }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const tool = createAdvancedSearchTool(() => TAVILY_CONFIG);
    const res = await exec(tool, { query: " kimi " });
    expect(res.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledOnce();
    const text = res.content.map((c) => c.text ?? "").join("\n");
    expect(text).toContain("1. Kimi");
    expect(text).toContain("https://moonshot.cn");
  });

  it("API 业务错误降级为错误文本，不炸流", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: 403, msg: "余额不足" }), { status: 200 })),
    );
    const tool = createAdvancedSearchTool(() => BOCHA_CONFIG);
    const res = await exec(tool, { query: "test" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("余额不足");
  });
});
