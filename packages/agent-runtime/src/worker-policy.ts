function extractCommand(args: unknown): string | null {
  if (!args || typeof args !== "object" || !("command" in args)) return null;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : null;
}

const GIT_READ_ONLY = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "grep",
  "blame",
  "describe",
  "shortlog",
  "reflog",
]);

function shellSegments(command: string): string[] {
  // Worker Git 边界宁可误拒复合命令，也不能只检查第一段后放行整条。
  return command
    .split(/&&|\|\||[|;\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function tokens(segment: string): string[] {
  return segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^(["'])|(["'])$/g, "")) ?? [];
}

/** 仅允许明确的 Git 只读子命令；ref/index/工作区变更全部失败关闭。 */
export function isWorkerGitReadOnly(segment: string): boolean {
  const parts = tokens(segment);
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0] ?? "")) parts.shift();
  const gitIndex = parts.findIndex((part) => part === "git" || part.endsWith("/git") || part.endsWith("\\git.exe"));
  if (gitIndex < 0) {
    // sh -c 'git add .' / node -e 等嵌套形式不做语义猜测；出现 Git 可执行名但不是
    // 当前段直接调用时一律拒绝，普通 echo 文本可能误拒，但不会在 Worker 中放大权限。
    return !/(?:^|[\s"'])(?:\S*[\\/])?git(?:\.exe)?\s/i.test(segment);
  }
  let index = gitIndex + 1;
  while (parts[index]?.startsWith("-")) {
    const option = parts[index]!;
    index++;
    if (["-C", "--git-dir", "--work-tree", "--namespace"].includes(option)) index++;
    if (["-c", "--exec-path"].includes(option)) return false;
  }
  const subcommand = parts[index];
  if (!subcommand || !GIT_READ_ONLY.has(subcommand)) return false;
  if (subcommand === "reflog" && parts.slice(index + 1).some((part) => ["expire", "delete", "exists"].includes(part))) {
    return false;
  }
  return true;
}

export function workerShellAllowed(command: string): boolean {
  return shellSegments(command).every(isWorkerGitReadOnly);
}

export function workerToolViolation(toolName: string, args: unknown): string | null {
  const name = toolName.toLowerCase();
  if (name === "task" || name.startsWith("mcp__")) return `Worker tool is disabled: ${toolName}`;
  if ((name === "bash" || name === "powershell") && !workerShellAllowed(extractCommand(args) ?? "")) {
    return "Worker Git policy: only explicit read-only Git commands are allowed. GitWorkspaceManager owns all commits.";
  }
  if (name === "renamesession" || name === "generateimage") return `Worker tool is disabled: ${toolName}`;
  return null;
}
