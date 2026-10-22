/**
 * RenameSession —— 让模型在理解用户意图后给会话起标题（Finch 的 Session rename 同款思路）。
 * 通过 onRename 回调把标题抛给宿主 → 主进程写注册表 + 广播给渲染进程。
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getLocale } from "@spcode/shared/i18n";
import { type Static, Type } from "typebox";

const schema = Type.Object({
  title: Type.String({
    description:
      "Short session title in the current UI language, max 30 Chinese or 60 English characters; honor an explicitly requested title language",
  }),
});

type Params = Static<typeof schema>;

export function createRenameSessionTool(onRename: (title: string) => void): ToolDefinition {
  return {
    name: "RenameSession",
    label: "Rename Session",
    description:
      "Set a short descriptive title for the current session (shown in the sidebar). Call once, early in the conversation, as soon as you understand what the user wants. Use the current UI language, not the input language, unless the user explicitly requests another title language. Do not call again afterwards.",
    promptSnippet: "Name the current session once you understand the task",
    parameters: schema,
    execute: async (_id, args: Params) => {
      const title = (args.title ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, getLocale() === "en" ? 60 : 30);
      if (!title) {
        return {
          content: [{ type: "text", text: "Empty title, ignored." }],
          details: { presentation: { key: "agent:tool.titleEmpty" } },
          isError: true,
        };
      }
      onRename(title);
      return {
        content: [{ type: "text", text: `Session renamed to "${title}".` }],
        details: { title, presentation: { key: "agent:tool.sessionRenamed", params: { title } } },
      };
    },
  };
}
