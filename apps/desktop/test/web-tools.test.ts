/**
 * WebSearch/WebFetch 真网测试：直接调工具 execute 打真实网络。
 * 失败优先怀疑本机网络，其次才是选择器失效。
 */
import { describe, expect, it } from "vitest";
import { createWebFetchTool } from "../src/agent-host/tools/webfetch.js";
import { createWebSearchTool } from "../src/agent-host/tools/websearch.js";

interface ToolResultLike {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

async function exec(tool: ReturnType<typeof createWebSearchTool>, args: Record<string, unknown>): Promise<ToolResultLike> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await tool.execute("t1", args as any, undefined, undefined, {} as any)) as ToolResultLike;
}

describe("WebSearch 真网", () => {
  it(
    "中文查询能拿到结果",
    async () => {
      const tool = createWebSearchTool();
      const res = await exec(tool, { query: "杭州 天气", numResults: 5 });
      expect(res.isError).toBeFalsy();
      const text = res.content.map((c) => c.text ?? "").join("\n");
      expect(text).toMatch(/1\. /);
      expect(text).toMatch(/https?:\/\//);
    },
    45000,
  );
});

describe("WebFetch 真网", () => {
  it(
    "抓取 example.com 转 Markdown",
    async () => {
      const tool = createWebFetchTool();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = (await tool.execute("t2", { url: "https://example.com" } as any, undefined, undefined, {} as any)) as ToolResultLike;
      expect(res.isError).toBeFalsy();
      const text = res.content.map((c) => c.text ?? "").join("\n");
      expect(text).toContain("Example Domain");
    },
    45000,
  );

  it("非法 URL 报错不炸", async () => {
    const tool = createWebFetchTool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await tool.execute("t3", { url: "not-a-url" } as any, undefined, undefined, {} as any)) as ToolResultLike;
    expect(res.isError).toBe(true);
  });
});
