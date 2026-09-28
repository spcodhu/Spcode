/**
 * TodoWrite —— 任务清单：既是给用户的进度展示，也是模型长任务中的"工作记忆外存"。
 * 状态变化通过 emitTodo 推送给 UI。
 */
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TodoItem } from "@spcode/shared";

const todoSchema = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String({ description: "Task description in imperative form" }),
      activeForm: Type.Optional(Type.String({ description: "Present-continuous form shown while in progress" })),
      status: Type.Union(
        [Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")],
        { description: "Task status" },
      ),
    }),
  ),
});

type Params = Static<typeof todoSchema>;

export function createTodoWriteTool(emitTodo: (todos: TodoItem[]) => void): ToolDefinition {
  let current: TodoItem[] = [];
  return {
    name: "TodoWrite",
    label: "Todo Write",
    description:
      "Record or update the current task checklist so the user can see progress. Call this whenever the plan changes. Update status immediately after each individual task — never batch multiple status changes into one deferred call.",
    promptSnippet: "Maintain the visible task checklist for long multi-step work",
    parameters: todoSchema,
    execute: async (_id, args: Params) => {
      current = args.todos.map((t) => ({
        content: t.content,
        activeForm: t.activeForm,
        status: t.status,
      }));
      emitTodo(current);
      const done = current.filter((t) => t.status === "completed").length;
      return {
        content: [{ type: "text", text: `Todo list updated: ${done}/${current.length} completed.` }],
        details: { todos: current },
      };
    },
  };
}
