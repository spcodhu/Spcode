/**
 * WebSearch/WebFetch 测试：解析/筛选逻辑用离线夹具，连通性用真网。
 * 真网失败优先怀疑本机网络，其次才是实现退化。
 */

import type { WebFetchConfig } from "@spcode/shared";
import { executeFetch, isWebFetchReady, parseFetchResponse } from "@spcode/shared/web-fetch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebFetchTool, filterByPrompt, truncateWithNotice } from "../src/agent-host/tools/webfetch.js";
import { createWebSearchTool, decodeBingRedirect, parseSearchMarkdown } from "../src/agent-host/tools/websearch.js";

interface ToolResultLike {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

async function exec(
  tool: ReturnType<typeof createWebSearchTool>,
  args: Record<string, unknown>,
): Promise<ToolResultLike> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await tool.execute("t1", args as any, undefined, undefined, {} as any)) as ToolResultLike;
}

// 真网连通性测试默认不跑（本机/CI 出口网络环境差异大，会抖动）；
// 需要验证真实抓取时显式开启：SPCODE_TEST_NETWORK=1 pnpm test（评审 R3-C0：默认 hermetic）
describe.skipIf(!process.env.SPCODE_TEST_NETWORK)("WebSearch 真网", () => {
  it("中文查询能拿到结果", async () => {
    const tool = createWebSearchTool();
    const res = await exec(tool, { query: "杭州 天气", numResults: 5 });
    expect(res.isError).toBeFalsy();
    const text = res.content.map((c) => c.text ?? "").join("\n");
    expect(text).toMatch(/1\. /);
    expect(text).toMatch(/https?:\/\//);
  }, 45000);
});

describe("parseSearchMarkdown（离线夹具）", () => {
  it("解析标题链接、解码 Bing 跳转、过滤自家链接并去重", () => {
    // u=a1 + base64url("https://www.zhihu.com/question/123") —— Bing 跳转包装
    const wrapped = `https://www.bing.com/ck/a?p=xxx&u=a1${Buffer.from("https://www.zhihu.com/question/123").toString("base64url")}`;
    const md = [
      "## [图片](https://www.bing.com/images/search?q=test)",
      "",
      `## [乌鸫科技是阿里外包吗 - 知乎](${wrapped})`,
      "",
      "这是摘要内容，一般会跟在标题后面。",
      "",
      "## [**加粗标题** 同样能解析](https://example.com/a)",
      "",
      `## [重复 URL 应去重](${wrapped})`,
      "",
      "## [短](https://example.com/short)",
      "",
      "## [微软官方文档](https://learn.microsoft.com/docs/x)",
    ].join("\n");
    const out = parseSearchMarkdown(md, 10);
    // bing.com/images 与 microsoft.com 被过滤、"短"（<5 字符）被过滤、重复 URL 去重
    expect(out).toHaveLength(2);
    expect(out[0]?.title).toBe("乌鸫科技是阿里外包吗 - 知乎");
    expect(out[0]?.url).toBe("https://www.zhihu.com/question/123");
    expect(out[0]?.snippet).toContain("摘要内容");
    expect(out[1]?.title).toBe("加粗标题 同样能解析");
    expect(out[1]?.url).toBe("https://example.com/a");
  });

  it("decodeBingRedirect：非法输入返回 undefined", () => {
    expect(decodeBingRedirect("https://example.com/plain")).toBeUndefined();
    expect(decodeBingRedirect("https://www.bing.com/ck/a?u=a1!!!not-base64!!!")).toBeUndefined();
  });
});

describe("filterByPrompt / truncateWithNotice（离线）", () => {
  it("保留命中段落 + 首尾段，保持原顺序", () => {
    const paras = Array.from({ length: 30 }, (_, i) => `第${i}段 无关内容填充`).join("\n\n");
    const md = `${paras}\n\n第31段 包含目标关键词外包的段落`;
    const out = filterByPrompt(md, "外包 待遇");
    expect(out).toContain("第0段"); // 首段保底
    expect(out).toContain("外包"); // 命中段
  });

  it("截断时标注省略量", () => {
    const md = Array.from({ length: 50 }, (_, i) => `段落${i} ${"长".repeat(50)}`).join("\n\n");
    const out = truncateWithNotice(md, 500);
    expect(out.length).toBeLessThan(md.length + 100);
    expect(out).toContain("[Output truncated:");
  });
});

describe.skipIf(!process.env.SPCODE_TEST_NETWORK)("WebFetch 真网", () => {
  it("抓取 example.com 转 Markdown", async () => {
    const tool = createWebFetchTool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await tool.execute(
      "t2",
      { url: "https://example.com" } as any,
      undefined,
      undefined,
      {} as any,
    )) as ToolResultLike;
    expect(res.isError).toBeFalsy();
    const text = res.content.map((c) => c.text ?? "").join("\n");
    expect(text).toContain("Example Domain");
  }, 45000);

  it("非法 URL 报错不炸", async () => {
    const tool = createWebFetchTool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await tool.execute(
      "t3",
      { url: "not-a-url" } as any,
      undefined,
      undefined,
      {} as any,
    )) as ToolResultLike;
    expect(res.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DeepSeek Fetch 后端（stub fetch，不打真网、不消耗额度）
// ---------------------------------------------------------------------------

const DS_FETCH: WebFetchConfig = {
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com/v1/tools/fetch",
  apiKey: "sk-ds-test",
};

describe("web-fetch 协议适配（离线）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("isWebFetchReady：缺 baseUrl/apiKey 不生效", () => {
    expect(isWebFetchReady(null)).toBe(false);
    expect(isWebFetchReady({ ...DS_FETCH, apiKey: " " })).toBe(false);
    expect(isWebFetchReady({ ...DS_FETCH, baseUrl: "" })).toBe(false);
    expect(isWebFetchReady(DS_FETCH)).toBe(true);
  });

  it("parseFetchResponse：字段缺失容错为空字符串", () => {
    expect(parseFetchResponse({ title: "T", content: "# 正文" })).toEqual({ title: "T", content: "# 正文" });
    expect(parseFetchResponse({})).toEqual({ title: "", content: "" });
    expect(parseFetchResponse("not-object")).toEqual({ title: "", content: "" });
  });

  it("executeFetch：POST {url} + Bearer 鉴权", async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
      expect(url).toBe("https://api.deepseek.com/v1/tools/fetch");
      expect(init?.headers?.Authorization).toBe("Bearer sk-ds-test");
      expect(JSON.parse(init?.body ?? "{}")).toEqual({ url: "https://example.com/a" });
      return new Response(JSON.stringify({ title: "T", content: "# 正文" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = await executeFetch(DS_FETCH, "https://example.com/a", 10_000);
    expect(page).toEqual({ title: "T", content: "# 正文" });
  });

  it("executeFetch：HTTP 错误附带 OpenAI 风格 error.message 明细", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "Insufficient Balance", type: "invalid_request_error", param: null } }),
            { status: 402 },
          ),
      ),
    );
    await expect(executeFetch(DS_FETCH, "https://example.com/a", 10_000)).rejects.toThrow(
      "HTTP 402: Insufficient Balance",
    );
  });
});

describe("WebFetch 工具 DeepSeek 后端（stub fetch）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function execFetch(
    tool: ReturnType<typeof createWebFetchTool>,
    args: Record<string, unknown>,
  ): Promise<ToolResultLike> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await tool.execute("tf", args as any, undefined, undefined, {} as any)) as ToolResultLike;
  }

  /** 分发 stub：DeepSeek 端点走 deepseekResp，其余（内置直连回退）返回 HTML 页 */
  function stubDispatch(
    deepseekResp: () => Response,
    builtinHtml = "<html><head><title>直连页</title></head><body><p>直连抓取内容</p></body></html>",
  ) {
    return vi.fn(async (url: unknown) => {
      if (String(url).includes("api.deepseek.com")) return deepseekResp();
      return new Response(builtinHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    });
  }

  it("配置 DeepSeek 后走 DeepSeek 抓取，信封头标注 Via", async () => {
    vi.stubGlobal(
      "fetch",
      stubDispatch(
        () => new Response(JSON.stringify({ title: "DS 标题", content: "# 服务端抓取的 Markdown" }), { status: 200 }),
      ),
    );
    const tool = createWebFetchTool(() => DS_FETCH);
    const res = await execFetch(tool, { url: "https://example.com/ds-ok" });
    expect(res.isError).toBeFalsy();
    const text = res.content.map((c) => c.text ?? "").join("\n");
    expect(text).toContain("Via: DeepSeek Fetch");
    expect(text).toContain("Title: DS 标题");
    expect(text).toContain("服务端抓取的 Markdown");
  });

  it("DeepSeek 失败（HTTP 500）自动回退内置直连，信封头注明原因", async () => {
    vi.stubGlobal(
      "fetch",
      stubDispatch(() => new Response("server error", { status: 500 })),
    );
    const tool = createWebFetchTool(() => DS_FETCH);
    // 字面公网 IP：SSRF 校验跳过 DNS 解析，回退路径全程 hermetic
    const res = await execFetch(tool, { url: "https://93.184.216.34/ds-fail" });
    expect(res.isError).toBeFalsy();
    const text = res.content.map((c) => c.text ?? "").join("\n");
    expect(text).toContain("Via: builtin (DeepSeek Fetch failed: HTTP 500");
    expect(text).toContain("直连抓取内容");
  });

  it("DeepSeek 返回空正文（不计费情形）按失败处理并回退", async () => {
    vi.stubGlobal(
      "fetch",
      stubDispatch(() => new Response(JSON.stringify({ title: "", content: "" }), { status: 200 })),
    );
    const tool = createWebFetchTool(() => DS_FETCH);
    const res = await execFetch(tool, { url: "https://93.184.216.34/ds-empty" });
    expect(res.isError).toBeFalsy();
    const text = res.content.map((c) => c.text ?? "").join("\n");
    expect(text).toContain("Via: builtin (DeepSeek Fetch failed: DeepSeek Fetch returned empty content)");
    expect(text).toContain("直连抓取内容");
  });

  it("未配置后端时走内置直连，无 Via 行", async () => {
    vi.stubGlobal(
      "fetch",
      stubDispatch(() => new Response("不应被调用", { status: 500 })),
    );
    const tool = createWebFetchTool(() => null);
    const res = await execFetch(tool, { url: "https://93.184.216.34/builtin" });
    expect(res.isError).toBeFalsy();
    const text = res.content.map((c) => c.text ?? "").join("\n");
    expect(text).not.toContain("Via:");
    expect(text).toContain("直连抓取内容");
  });
});
