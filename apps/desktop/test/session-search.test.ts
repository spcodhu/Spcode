/**
 * 会话全文搜索单测：JSONL 命中提取 + searchSessions 的排序/上限语义。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SessionRegistryEntry } from "../src/main/session-registry.js";
import { findHitsInLines, searchSessions } from "../src/main/session-search.js";

let dir = "";

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function jsonlMessage(role: string, text: string, ts = "2026-09-29T10:00:00.000Z"): string {
  return JSON.stringify({
    type: "message",
    timestamp: ts,
    message: { role, content: [{ type: "text", text }] },
  });
}

function entry(id: string, title: string, sessionFile: string | null, updatedAt = 0): SessionRegistryEntry {
  return {
    id,
    mode: "chat",
    cwd: "",
    title,
    model: null,
    thinkingLevel: "medium",
    sessionFile,
    createdAt: 0,
    updatedAt,
  };
}

describe("findHitsInLines", () => {
  it("命中 user/assistant 文本块并截取上下文摘要", () => {
    const lines = [
      jsonlMessage("user", "我想了解大模型应急运维工程师的工作内容"),
      jsonlMessage("assistant", "好的，大模型应急运维主要包括以下几个方面……"),
      jsonlMessage("system", "不该被命中的系统提示 大模型"),
    ];
    const hits = findHitsInLines(lines, "大模型");
    expect(hits).toHaveLength(2);
    expect(hits[0].role).toBe("user");
    expect(hits[0].snippet).toContain("大模型");
    expect(hits[0].timestamp).toBe(Date.parse("2026-09-29T10:00:00.000Z"));
  });

  it("大小写不敏感 + 长文本摘要带省略号", () => {
    const long = `前面${"很".repeat(60)}WebSearch 工具${"后".repeat(60)}`;
    const hits = findHitsInLines([jsonlMessage("user", long)], "websearch");
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet.startsWith("…")).toBe(true);
    expect(hits[0].snippet.endsWith("…")).toBe(true);
  });

  it("坏行跳过、每个会话最多 3 条命中", () => {
    const lines = ["这不是 JSON", ...Array.from({ length: 6 }, (_, i) => jsonlMessage("user", `第 ${i} 条包含关键词`))];
    const hits = findHitsInLines(lines, "关键词");
    expect(hits).toHaveLength(3);
  });
});

describe("searchSessions", () => {
  it("标题命中排正文命中前面；无会话文件的条目只匹配标题", async () => {
    dir = mkdtempSync(join(tmpdir(), "spcode-search-"));
    const file = join(dir, "s1.jsonl");
    writeFileSync(file, `${jsonlMessage("user", "聊聊小米手机的品控")}\n`, "utf-8");
    const entries = [entry("a", "随便聊聊", file, 100), entry("b", "小米手机选购", null, 200)];
    const results = await searchSessions(entries, "小米");
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("b"); // 标题命中优先
    expect(results[0].titleMatch).toBe(true);
    expect(results[1].id).toBe("a");
    expect(results[1].hits).toHaveLength(1);
  });

  it("空查询返回空；不存在的会话文件静默跳过", async () => {
    expect(await searchSessions([entry("x", "标题", null)], "  ")).toEqual([]);
    const results = await searchSessions([entry("x", "别的标题", "/no/such/file.jsonl")], "关键词");
    expect(results).toEqual([]);
  });
});
