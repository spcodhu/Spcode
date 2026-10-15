/**
 * WebSearch/WebFetch 测试：解析/筛选逻辑用离线夹具，连通性用真网。
 * 真网失败优先怀疑本机网络，其次才是实现退化。
 */
import { describe, expect, it } from "vitest";
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

// 真网连通性测试只在本地跑：CI runner 出口地区与本机不同，Bing 对中文查询可能返回空结果
// （beta.10 流水线曾因此双平台 Test 失败）；离线夹具测试不受影响，CI 全量跑。
describe.skipIf(process.env.CI)("WebSearch 真网", () => {
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

describe("WebFetch 真网", () => {
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
