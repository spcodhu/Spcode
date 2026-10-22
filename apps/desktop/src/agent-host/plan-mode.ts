/**
 * 计划模式(Plan Mode)公共定义:工具集、注入消息、bash 只读白名单。
 *
 * 设计要点(见 docs/plan-mode-design.md):
 * - 计划态 = 只读调研:edit/write/Task/TodoWrite 从工具列表摘除,bash 走白名单;
 * - 退出无独立按钮:模型调 ExitPlanMode 弹批准卡,批准后 harness 当场恢复全量工具;
 * - 注入消息走 session.sendCustomMessage(display:false),模型可见、UI 不显示。
 */

/** 正常态工具集(创建会话即固定,保证 WritePlan/ExitPlanMode 在正常态不可见) */
export const NORMAL_MODE_TOOLS = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "WebSearch",
  "AdvancedSearch",
  "WebFetch",
  "TodoWrite",
  "AskUserQuestion",
  "RenameSession",
  "Task",
];

/** 计划态工具集:只读 + 提问 + 计划文件 + 退出申请(未知名字 pi 会自动忽略) */
export const PLAN_MODE_TOOLS = [
  "read",
  "bash",
  "powershell",
  "grep",
  "find",
  "ls",
  "WebSearch",
  "AdvancedSearch",
  "WebFetch",
  "AskUserQuestion",
  "RenameSession",
  "WritePlan",
  "ExitPlanMode",
];

/** sendCustomMessage 的 customType(注入消息与历史回放的识别标记) */
export const PLAN_MODE_CUSTOM_TYPE = "spcode-plan-mode";

/** 进入计划态时注入的工作约定(模型可见,UI 不显示) */
export const PLAN_MODE_ON_MESSAGE = `[Plan mode enabled]
You are in plan mode: read-only research, no modifications. Write tools such as edit/write have been removed; bash is limited to read-only commands.

Workflow:
1. Research thoroughly with read-only tools (file reading, search, read-only bash commands).
2. Batch questions requiring user decisions into one AskUserQuestion call (2-4 options per question), rather than asking piecemeal. Use the current UI language for questions and options.
3. Once research is sufficient, call WritePlan to save the complete plan in the current UI language. Then present the full plan in your response, without truncation or omissions.
4. After presenting the plan, proactively call ExitPlanMode once to ask whether to execute. Even if the user expresses a desire to proceed, you must call ExitPlanMode before making changes.

Do not modify anything until the user approves through ExitPlanMode. Honor explicit user requests for a different language.`;

/** 用户在 Composer 手动关闭计划态时注入(中性,不代表批准计划) */
export const PLAN_MODE_OFF_MESSAGE = `[Plan mode disabled]
The user manually disabled plan mode. All tools have been restored.`;

/** 计划态下 bash 被拒绝时的提示 */
export const PLAN_MODE_BASH_BLOCK_REASON =
  "Plan mode is read-only: this command is not on the read-only allowlist. Continue research with read-only commands (cat/grep/find/ls/git status, etc.); when the plan is ready, call ExitPlanMode to request user approval.";

/** 计划态下漏网写调用被拒绝时的提示 */
export const PLAN_MODE_WRITE_BLOCK_REASON =
  "Modifications are forbidden in plan mode. Finish the plan and call ExitPlanMode for user approval first; write tools are automatically restored after approval.";

// ---------------------------------------------------------------------------
// bash 只读白名单
// ---------------------------------------------------------------------------

/** 直接只读的命令(首词命中即该段安全)。
 *  注意:env/less/more 不在列——env 能执行任意程序(env rm -rf x 逃逸),
 *  less/more 支持 !cmd 交互执行;读环境变量请用 printenv。 */
const SAFE_BINARIES = new Set([
  "cat",
  "head",
  "tail",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "find",
  "fd",
  "ls",
  "pwd",
  "tree",
  "wc",
  "file",
  "stat",
  "echo",
  "printf",
  "printenv",
  "which",
  "type",
  "whoami",
  "date",
  "uname",
  "uptime",
  "hostname",
  "sort",
  "uniq",
  "comm",
  "diff",
  "cut",
  "tr",
  "jq",
  "yq",
  "du",
  "df",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "cd",
  "true",
]);

/** git 只允许这些只读子命令 */
const SAFE_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "tag",
  "blame",
  "rev-parse",
  "describe",
  "remote",
  "ls-files",
  "ls-tree",
  "shortlog",
  "reflog",
  "grep",
  "config",
  "stash",
  "rev-list",
]);

/** npm/pnpm/yarn 只允许这些查询子命令 */
const SAFE_PKG_SUBCOMMANDS = new Set([
  "list",
  "ls",
  "outdated",
  "view",
  "info",
  "why",
  "bin",
  "root",
  "prefix",
  "audit",
]);

/** 段分隔符:管道、与或、分号、换行（评审 R3-C5：换行不分段则 "cat a\nrm -rf x" 首词 cat 即放行整串） */
const SEGMENT_SPLIT = /\|\||&&|[|;\n]/;

/** find 的这些旗标能删文件/执行命令/写文件,命中即不安全 */
const DANGEROUS_FIND_FLAGS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fls",
  "-fprintf",
  "-fprint",
  "-fprint0",
]);

/**
 * 计划态 bash 命令安全性判定。
 * 按管道/连接符/换行拆段,逐段检查首词(及其子命令)是否在只读白名单内;
 * 命令替换与输出重定向一律拒绝(它们能藏写操作)。
 * 评审 R3-C5：重定向判定改为任意 >/< 字符即拒（含无空格 `echo hi>x`、`2>`、`&>` 形态）——
 * 计划模式是只读承诺，宁可误拦合法读取也不放写。
 */
export function isPlanModeSafeCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  // 命令替换 $(...) / `...` 一律拒绝
  if (/`|\$\(/.test(cmd)) return false;
  // 任意重定向字符一律拒绝（含无空格、fd 前缀、&> 形态）
  if (/[<>]/.test(cmd)) return false;
  for (const segment of cmd.split(SEGMENT_SPLIT)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const bin = tokens[0]!;
    // 白名单内命令的危险旗标特例
    if (bin === "find" && tokens.some((t) => DANGEROUS_FIND_FLAGS.has(t))) return false;
    if (bin === "sort" && tokens.some((t) => t === "-o" || t.startsWith("--output"))) return false;
    if (SAFE_BINARIES.has(bin)) continue;
    if (bin === "git") {
      // 跳过全局旗标(-C/-c/--git-dir 等),取第一个非旗标词当子命令
      const sub = tokens.slice(1).find((t) => !t.startsWith("-"));
      if (!sub || !SAFE_GIT_SUBCOMMANDS.has(sub)) return false;
      // git stash 只允许 list/show;git config 只在明确读取形(--get/-l/单位置参数)放行
      if (sub === "stash" && !tokens.some((t) => t === "list" || t === "show")) return false;
      if (sub === "config") {
        const rest = tokens.slice(tokens.indexOf("config") + 1);
        const hasReadFlag = rest.some((t) => ["--get", "--get-all", "--get-regexp", "-l", "--list"].includes(t));
        const positional = rest.filter((t) => !t.startsWith("-"));
        // 两个及以上位置参数是写(git config key value);key=value 形式也是写
        if (!hasReadFlag && positional.length >= 2) return false;
        if (positional.some((t) => t.includes("="))) return false;
        // --unset/--unset-all/--add/--replace-all/--rename-section/--remove-section 等写旗标一律拒
        if (rest.some((t) => /^--(unset|add|replace|rename|remove)/.test(t))) return false;
        continue;
      }
      // 评审 R3-C5：branch/tag/remote 只允许只读形态（裸列表/-a/-v/--list/--show-current/show/get-url），
      // 其余（-d/-D/-m/-f/位置参数=创建/add/remove/set-url/prune 等）一律拒
      if (sub === "branch" || sub === "tag") {
        const rest = tokens.slice(tokens.indexOf(sub) + 1);
        const READ_FLAGS = new Set([
          "-a",
          "--all",
          "-v",
          "--verbose",
          "-vv",
          "--list",
          "-l",
          "--show-current",
          "-n",
          "--points-at",
          "--sort",
          "--contains",
          "--no-contains",
          "--merged",
          "--no-merged",
          "--format",
          "--column",
          "--no-column",
          "--color",
          "--no-color",
          "-q",
          "--quiet",
        ]);
        for (const t of rest) {
          if (t.startsWith("-")) {
            // 带值旗标的值不单独校验（--format 后跟什么都只是格式串）
            if (
              !READ_FLAGS.has(t) &&
              !t.startsWith("--sort=") &&
              !t.startsWith("--format=") &&
              !t.startsWith("--points-at=") &&
              !t.startsWith("--contains=") &&
              !t.startsWith("--column=") &&
              !t.startsWith("--color=")
            )
              return false;
          } else {
            return false; // 位置参数 = 创建/删除分支或打标签
          }
        }
        continue;
      }
      if (sub === "remote") {
        // 只放行 git remote / -v / show / get-url
        const rest = tokens.slice(tokens.indexOf("remote") + 1).filter((t) => !t.startsWith("-"));
        if (rest.length > 0 && rest[0] !== "show" && rest[0] !== "get-url") return false;
        continue;
      }
      continue;
    }
    if (bin === "npm" || bin === "pnpm" || bin === "yarn") {
      const sub = tokens.slice(1).find((t) => !t.startsWith("-"));
      if (!sub || !SAFE_PKG_SUBCOMMANDS.has(sub)) return false;
      // npm/pnpm/yarn audit 只允许纯审计（audit fix 会改 package-lock/node_modules）
      if (sub === "audit") {
        const rest = tokens.slice(tokens.indexOf(sub) + 1).filter((t) => !t.startsWith("-"));
        if (rest.length > 0) return false;
      }
      continue;
    }
    return false;
  }
  return true;
}
