/**
 * TodoWrite —— 任务清单：既是给用户的进度展示，也是模型长任务中的"工作记忆外存"。
 * 状态变化通过 emitTodo 推送给 UI。
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TodoItem } from "@spcode/shared";
import { type Static, Type } from "typebox";
import { STRICT_PREFER_TOOL_SAMPLING } from "./tool-schema.js";

const todoSchema = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String({
        description:
          "Task description in imperative form, in the current UI language unless explicitly requested otherwise",
        minLength: 1,
      }),
      activeForm: Type.Optional(
        Type.String({
          description: "In-progress wording in the current UI language unless explicitly requested otherwise",
          minLength: 1,
        }),
      ),
      status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
        description: "Task status",
      }),
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
      "Record or update the current task checklist so the user can see progress. Always provide the complete list: each call replaces the previous list, and an empty array clears it. Keep at most one task in_progress. Call this whenever the plan changes. Update status immediately after each individual task — never batch multiple status changes into one deferred call.",
    promptSnippet: "Maintain the visible task checklist for long multi-step work",
    parameters: todoSchema,
    constrainedSampling: STRICT_PREFER_TOOL_SAMPLING,
    execute: async (_id, args: Params) => {
      if (!Array.isArray(args.todos)) {
        return {
          content: [{ type: "text", text: "Invalid TodoWrite input: todos must be an array." }],
          details: undefined,
          isError: true,
        };
      }
      if (
        args.todos.some((todo) => !todo.content.trim() || (todo.activeForm !== undefined && !todo.activeForm.trim()))
      ) {
        return {
          content: [{ type: "text", text: "Invalid TodoWrite input: content and activeForm must not be blank." }],
          details: undefined,
          isError: true,
        };
      }
      if (args.todos.filter((todo) => todo.status === "in_progress").length > 1) {
        return {
          content: [{ type: "text", text: "Invalid TodoWrite input: at most one task may be in_progress." }],
          details: undefined,
          isError: true,
        };
      }
      current = args.todos.map((t) => ({
        content: t.content,
        activeForm: t.activeForm,
        status: t.status,
      }));
      emitTodo(current);
      const done = current.filter((t) => t.status === "completed").length;
      return {
        content: [{ type: "text", text: `Todo list updated: ${done}/${current.length} completed.` }],
        details: {
          todos: current,
          presentation: { key: "agent:tool.todosUpdated", params: { done, total: current.length } },
        },
      };
    },
  };
}
