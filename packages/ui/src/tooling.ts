/**
 * 双端共用的工具展示元信息：中文动作标签 + 参数摘要（纯逻辑，无 UI 依赖）。
 */

import { i18n } from "@spcode/shared/i18n";

const TOOL_LABELS = {
  read: "tool.read",
  write: "tool.write",
  edit: "tool.edit",
  bash: "tool.command",
  powershell: "tool.command",
  shell: "tool.command",
  exec_command: "tool.command",
  grep: "tool.grep",
  glob: "tool.find",
  find: "tool.find",
  ls: "tool.ls",
  websearch: "tool.websearch",
  webfetch: "tool.webfetch",
  todowrite: "tool.todowrite",
  askuserquestion: "tool.askuserquestion",
  task: "tool.task",
  renamesession: "tool.renamesession",
  writeplan: "tool.writeplan",
  exitplanmode: "tool.exitplanmode",
  remember: "tool.remember",
  skill: "tool.skill",
} as const;

const COMMAND_TOOLS = new Set(["bash", "powershell", "shell", "exec_command"]);

export function toolLabel(name: string): string {
  const normalized = name.toLowerCase();
  const key = Object.hasOwn(TOOL_LABELS, normalized) ? TOOL_LABELS[normalized as keyof typeof TOOL_LABELS] : undefined;
  return key ? i18n.t(`chat:${key}`) : name;
}

export function thinkingLevelLabel(level: string): string {
  switch (level) {
    case "off":
      return i18n.t("chat:thinking.off");
    case "minimal":
      return i18n.t("chat:thinking.minimal");
    case "low":
      return i18n.t("chat:thinking.low");
    case "medium":
      return i18n.t("chat:thinking.medium");
    case "high":
      return i18n.t("chat:thinking.high");
    case "xhigh":
      return i18n.t("chat:thinking.xhigh");
    case "max":
      return i18n.t("chat:thinking.max");
    default:
      return level;
  }
}

export function isCommandTool(name: string): boolean {
  return COMMAND_TOOLS.has(name.toLowerCase());
}

export function summarizeArgs(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const pick = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  switch (name.toLowerCase()) {
    case "read":
    case "write":
    case "edit":
      return pick("path") || pick("file_path");
    case "bash":
    case "powershell":
      return pick("command").slice(0, 120);
    case "grep":
      return `/${pick("pattern")}/`;
    case "websearch":
      return pick("query");
    case "webfetch":
      return pick("url");
    case "todowrite": {
      const arr = a.todos;
      if (Array.isArray(arr)) {
        const done = arr.filter((t) => (t as { status?: string })?.status === "completed").length;
        return i18n.t("chat:tool.todoProgress", { done, total: arr.length });
      }
      return "";
    }
    default: {
      for (const k of ["title", "description", "prompt", "query", "text", "message", "path", "command", "url"]) {
        const v = pick(k);
        if (v) return v.slice(0, 120);
      }
      return "";
    }
  }
}
