import { describe, expect, it } from "vitest";
import { historyToMessages, messageText, type Segment } from "../src/renderer/src/store.js";

function kinds(segments: Segment[] | undefined): string[] {
  return (segments ?? []).map((s) => s.kind);
}

describe("historyToMessages", () => {
  it("还原 user/assistant 消息与工具调用配对，段保持 content 原有顺序", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "看下这个文件" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先读文件" },
          { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "read",
        content: [{ type: "text", text: "文件内容…" }],
        isError: false,
      },
      { role: "assistant", content: [{ type: "text", text: "这个文件是…" }] },
    ];
    const out = historyToMessages(messages);
    expect(out).toHaveLength(3);
    expect(out[0]?.role).toBe("user");
    expect(messageText(out[0]!)).toBe("看下这个文件");
    // 段顺序：thinking → tools（与 content 一致）
    expect(kinds(out[1]?.segments)).toEqual(["thinking", "tools"]);
    const thinking = out[1]?.segments[0];
    expect(thinking?.kind === "thinking" && thinking.text).toBe("先读文件");
    const tools = out[1]?.segments[1];
    expect(tools?.kind === "tools" && tools.calls[0]?.name).toBe("read");
    expect(tools?.kind === "tools" && tools.calls[0]?.status).toBe("done");
    expect(tools?.kind === "tools" && tools.calls[0]?.output).toBe("文件内容…");
    expect(messageText(out[2]!)).toBe("这个文件是…");
  });

  it("工具错误标记为 error，空消息被跳过", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t9", name: "bash", arguments: { command: "ls" } }],
      },
      {
        role: "toolResult",
        toolCallId: "t9",
        toolName: "bash",
        content: [{ type: "text", text: "boom" }],
        isError: true,
      },
      { role: "assistant", content: [] },
    ];
    const out = historyToMessages(messages);
    expect(out).toHaveLength(1);
    const tools = out[0]?.segments[0];
    expect(tools?.kind === "tools" && tools.calls[0]?.status).toBe("error");
    expect(tools?.kind === "tools" && tools.calls[0]?.output).toBe("boom");
  });

  it("交错 content 块按原顺序还原（思考→文本→工具→文本）", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "想一下" },
          { type: "text", text: "先搜一下" },
          { type: "toolCall", id: "s1", name: "websearch", arguments: { query: "q" } },
          { type: "toolCall", id: "s2", name: "websearch", arguments: { query: "q2" } },
          { type: "text", text: "再补充" },
        ],
      },
    ];
    const out = historyToMessages(messages);
    expect(kinds(out[0]?.segments)).toEqual(["thinking", "text", "tools", "text"]);
    const tools = out[0]?.segments[2];
    expect(tools?.kind === "tools" && tools.calls).toHaveLength(2);
  });

  it("忽略 system 与无内容消息", () => {
    const messages = [
      { role: "system", content: [{ type: "text", text: "sys" }] },
      { role: "user", content: [] },
    ];
    expect(historyToMessages(messages)).toHaveLength(0);
  });

  it("还原用户消息里的图片附件（含纯图片消息）", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          { type: "text", text: "能看见图片上的内容吗?" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "能看见。" }] },
      { role: "user", content: [{ type: "image", data: "aW1nMg==", mimeType: "image/jpeg" }] },
    ];
    const out = historyToMessages(messages);
    expect(out).toHaveLength(3);
    // 图文消息：图片进 images，文本保持原文
    expect(out[0]?.images).toEqual([{ name: "image-1", mimeType: "image/png", data: "aGVsbG8=" }]);
    expect(messageText(out[0]!)).toBe("能看见图片上的内容吗?");
    // 纯图片消息不丢消息体
    expect(out[2]?.images).toEqual([{ name: "image-1", mimeType: "image/jpeg", data: "aW1nMg==" }]);
    expect(messageText(out[2]!)).toBe("");
  });
});
