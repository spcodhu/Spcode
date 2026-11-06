import { describe, expect, it, vi } from "vitest";
import { createTodoWriteTool } from "../src/agent-host/tools/todowrite.js";

describe("TodoWrite 工具契约", () => {
  it("全量替换清单，允许全部完成和空数组清空", async () => {
    const emit = vi.fn();
    const tool = createTodoWriteTool(emit);
    await tool.execute(
      "valid",
      {
        todos: [
          { content: "完成第一项", activeForm: "正在完成第一项", status: "completed" },
          { content: "完成第二项", activeForm: "正在完成第二项", status: "completed" },
        ],
      },
      undefined as never,
    );
    await tool.execute("clear", { todos: [] }, undefined as never);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith([]);
    expect(tool.description).toContain("replaces the previous list");
    expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
  });

  it("空白文本与多个进行中任务在 emit 前失败", async () => {
    const invalidInputs = [
      { todos: [{ content: " ", status: "pending" }] },
      { todos: [{ content: "任务", activeForm: " ", status: "in_progress" }] },
      {
        todos: [
          { content: "任务一", status: "in_progress" },
          { content: "任务二", status: "in_progress" },
        ],
      },
    ];
    for (const input of invalidInputs) {
      const emit = vi.fn();
      const tool = createTodoWriteTool(emit);
      const result = await tool.execute("invalid", input as never, undefined as never);
      expect(result.isError).toBe(true);
      expect(emit).not.toHaveBeenCalled();
    }
  });
});
