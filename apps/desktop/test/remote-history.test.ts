import {
  historyToRemoteChunks,
  historyToRemotePage,
  REMOTE_HISTORY_PAGE_BYTES,
  REMOTE_HISTORY_PAGE_CHUNKS,
  REMOTE_HISTORY_TEXT_BYTES,
} from "@spcode/shared/remote-history";
import { describe, expect, it } from "vitest";

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("手机历史转换", () => {
  it("保持用户、thinking、正文、错误与压缩摘要顺序，忽略工具和图片载荷", () => {
    const chunks = historyToRemoteChunks([
      { role: "user", content: [{ type: "text", text: "原始问题 {{keep}}" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先分析" },
          { type: "toolCall", id: "t1", name: "bash", arguments: { command: "secret" } },
          { type: "text", text: "原始回答" },
        ],
      },
      { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "很大的工具结果" }] },
      { role: "assistant", content: [], stopReason: "error", errorMessage: " 原始错误 " },
      { role: "compactionSummary", summary: "原始压缩摘要" },
      { role: "user", content: [{ type: "image", data: "base64-image" }] },
    ]);

    expect(chunks).toEqual([
      { kind: "user", chunk: "原始问题 {{keep}}" },
      { kind: "thinking", chunk: "先分析" },
      { kind: "text", chunk: "原始回答" },
      { kind: "notice", chunk: "原始错误" },
      { kind: "notice", chunk: "原始压缩摘要" },
    ]);
  });

  it("超长文本按 UTF-8 码点切分，拼接后原文不变且每块不超限", () => {
    const source = "甲🙂".repeat(5000);
    const chunks = historyToRemoteChunks([{ role: "assistant", content: [{ type: "text", text: source }] }]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.chunk).join("")).toBe(source);
    for (const chunk of chunks) expect(bytes(chunk.chunk)).toBeLessThanOrEqual(REMOTE_HISTORY_TEXT_BYTES);
  });
});

describe("手机历史分页", () => {
  it("最近一页与更早游标衔接，不重复、不遗漏", () => {
    const content = Array.from({ length: REMOTE_HISTORY_PAGE_CHUNKS + 20 }, (_, index) => ({
      type: "text",
      text: `chunk-${index}`,
    }));
    const messages = [{ role: "assistant", content }];
    const latest = historyToRemotePage(messages);
    expect(latest.chunks).toHaveLength(REMOTE_HISTORY_PAGE_CHUNKS);
    expect(latest.olderBefore).toBe(20);
    expect(latest.chunks[0]?.chunk).toBe("chunk-20");

    const older = historyToRemotePage(messages, latest.olderBefore!);
    expect(older.chunks).toHaveLength(20);
    expect(older.olderBefore).toBeNull();
    expect([...older.chunks, ...latest.chunks].map((c) => c.chunk)).toEqual(content.map((c) => c.text));
  });

  it("每页明文文本有字节预算，避免加密后突破 relay 单帧限制", () => {
    const messages = [
      {
        role: "assistant",
        content: Array.from({ length: 30 }, () => ({ type: "text", text: "x".repeat(REMOTE_HISTORY_TEXT_BYTES) })),
      },
    ];
    const page = historyToRemotePage(messages);
    expect(page.chunks.length).toBeGreaterThan(0);
    expect(page.olderBefore).not.toBeNull();
    expect(page.chunks.reduce((sum, c) => sum + bytes(c.chunk) + 32, 0)).toBeLessThanOrEqual(REMOTE_HISTORY_PAGE_BYTES);
  });
});
