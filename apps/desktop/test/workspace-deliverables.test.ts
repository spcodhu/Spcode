import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/renderer/src/store.js";
import { workspaceDeliverables } from "../src/renderer/src/workspace-deliverables.js";

function assistant(text: string): ChatMessage {
  return { id: text, role: "assistant", segments: [{ kind: "text", id: `${text}-seg`, text }], streaming: false };
}

describe("工作区会话文件列表", () => {
  it("只收助手正文明确分享的本地文件，按路径去重", () => {
    const messages: ChatMessage[] = [
      {
        id: "user",
        role: "user",
        segments: [{ kind: "text", id: "u", text: "请看 [用户文件](user.txt)" }],
        streaming: false,
      },
      {
        id: "tools",
        role: "assistant",
        segments: [
          {
            kind: "tools",
            id: "t",
            calls: [
              {
                id: "write-1",
                name: "write",
                args: { path: "internal.ts" },
                status: "done",
                output: "Successfully wrote to internal.ts",
              },
            ],
          },
        ],
        streaming: false,
      },
      assistant("已生成 [报告](docs/report.md)，源文件见 [报告](docs/report.md) 和 [计划](plan:/tmp/PLAN.md)。"),
      assistant("![插图](images/a.png) [网页](https://example.com/a.md) `[代码示例](example.ts)`"),
    ];
    expect(workspaceDeliverables(messages)).toEqual([
      { path: "docs/report.md", label: "报告", kind: "file" },
      { path: "/tmp/PLAN.md", label: "计划", kind: "plan" },
    ]);
  });

  it("没有明确文件链接时返回空列表", () => {
    expect(workspaceDeliverables([assistant("只说明过程，没有交付文件。")])).toEqual([]);
  });
});
