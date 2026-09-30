/**
 * RenameSession —— 让模型在理解用户意图后给会话起标题（Finch 的 Session rename 同款思路）。
 * 通过 onRename 回调把标题抛给宿主 → 主进程写注册表 + 广播给渲染进程。
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { cleanSessionTitle } from "@spcode/shared";
import { type Static, Type } from "typebox";

const schema = Type.Object({
  title: Type.String({ description: "Short session title in the user's language, max 30 chars" }),
});

type Params = Static<typeof schema>;

export function createRenameSessionTool(onRename: (title: string) => void): ToolDefinition {
  return {
    name: "RenameSession",
    label: "Rename Session",
    description:
      "Set a short descriptive title for the current session (shown in the sidebar). Call once, early in the conversation, as soon as you understand what the user wants. Use the user's language. Do not call again afterwards.",
    promptSnippet: "Name the current session once you understand the task",
    parameters: schema,
    execute: async (_id, args: Params) => {
      const title = cleanSessionTitle(args.title ?? "");
      if (!title) {
        return { content: [{ type: "text", text: "Empty title, ignored." }], details: undefined, isError: true };
      }
      onRename(title);
      return { content: [{ type: "text", text: `Session renamed to "${title}".` }], details: { title } };
    },
  };
}
