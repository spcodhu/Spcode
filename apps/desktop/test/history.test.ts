import { describe, expect, it } from "vitest";
import { historyToMessages } from "../src/renderer/src/store.js";

describe("historyToMessages", () => {
  it("还原 user/assistant 消息与工具调用配对", () => {
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
    expect(out[0]?.text).toBe("看下这个文件");
    expect(out[1]?.role).toBe("assistant");
    expect(out[1]?.thinking).toBe("先读文件");
    expect(out[1]?.toolCalls).toHaveLength(1);
    expect(out[1]?.toolCalls[0]?.name).toBe("read");
    expect(out[1]?.toolCalls[0]?.status).toBe("done");
    expect(out[1]?.toolCalls[0]?.output).toBe("文件内容…");
    expect(out[2]?.text).toBe("这个文件是…");
  });

  it("工具错误标记为 error，空消息被跳过", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t9", name: "bash", arguments: { command: "ls" } }],
      },
      { role: "toolResult", toolCallId: "t9", toolName: "bash", content: [{ type: "text", text: "boom" }], isError: true },
      { role: "assistant", content: [] },
    ];
    const out = historyToMessages(messages);
    expect(out).toHaveLength(1);
    expect(out[0]?.toolCalls[0]?.status).toBe("error");
    expect(out[0]?.toolCalls[0]?.output).toBe("boom");
  });

  it("忽略 system 与无内容消息", () => {
    const messages = [
      { role: "system", content: [{ type: "text", text: "sys" }] },
      { role: "user", content: [] },
    ];
    expect(historyToMessages(messages)).toHaveLength(0);
  });
});
