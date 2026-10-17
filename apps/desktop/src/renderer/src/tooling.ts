/**
 * 工具元信息：中文动作标签 + 参数摘要（纯逻辑，无 UI 依赖）。
 * 供消息时间线（MessageItem）与运行状态条（run-status）共用。
 */

/** 工具名的中文动作标签（Finch 风格：读文件/改文件/命令/搜索…） */
const TOOL_LABELS: Record<string, string> = {
  read: "读文件",
  write: "写文件",
  edit: "改文件",
  bash: "命令",
  powershell: "命令",
  grep: "代码搜索",
  glob: "找文件",
  find: "找文件",
  ls: "列目录",
  websearch: "搜索",
  webfetch: "抓取",
  todowrite: "计划",
  askuserquestion: "提问",
  task: "子任务",
  renamesession: "改标题",
  writeplan: "写计划",
  exitplanmode: "计划审批",
  remember: "记忆",
  skill: "技能",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name.toLowerCase()] ?? name;
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
      // 计划行摘要显示进度：n/m 完成
      const arr = a.todos;
      if (Array.isArray(arr)) {
        const done = arr.filter((t) => (t as { status?: string })?.status === "completed").length;
        return `${done}/${arr.length} 完成`;
      }
      return "";
    }
    default: {
      // 未知工具：取第一个有信息量的字符串参数做摘要，避免与标签重复叠字
      for (const k of ["title", "description", "prompt", "query", "text", "message", "path", "command", "url"]) {
        const v = pick(k);
        if (v) return v.slice(0, 120);
      }
      return "";
    }
  }
}
