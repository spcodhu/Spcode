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
  "WebFetch",
  "AskUserQuestion",
  "RenameSession",
  "WritePlan",
  "ExitPlanMode",
];

/** sendCustomMessage 的 customType(注入消息与历史回放的识别标记) */
export const PLAN_MODE_CUSTOM_TYPE = "spcode-plan-mode";

/** 进入计划态时注入的工作约定(模型可见,UI 不显示) */
export const PLAN_MODE_ON_MESSAGE = `[计划模式已开启]
你正处于计划模式:只读调研,禁止任何改动。edit/write 等写工具已被移除,bash 仅限只读命令。

工作流程:
1. 用只读工具充分调研(读文件、搜索、只读 bash 命令)。
2. 有需要用户拍板的问题时,把多个问题攒成一次 AskUserQuestion 批量抛出(每题 2-4 个选项),不要东一句西一句地问。
3. 调研充分后,先调用 WritePlan 把完整计划写入计划文件,然后在回复正文里完整展示计划全文,不截断、不省略。
4. 展示计划后,主动调用一次 ExitPlanMode 询问用户是否开始执行。用户回复表达执行意愿时,也必须调用 ExitPlanMode,不得直接开始改动。

未经用户通过 ExitPlanMode 批准,不做任何修改。`;

/** 用户在 Composer 手动关闭计划态时注入(中性,不代表批准计划) */
export const PLAN_MODE_OFF_MESSAGE = `[计划模式已关闭]
计划模式已由用户手动关闭,全部工具已恢复。`;

/** 计划态下 bash 被拒绝时的提示 */
export const PLAN_MODE_BASH_BLOCK_REASON =
  "计划模式为只读:该命令不在只读白名单内。继续调研请用只读命令(cat/grep/find/ls/git status 等);计划就绪后调用 ExitPlanMode 请求用户批准。";

/** 计划态下漏网写调用被拒绝时的提示 */
export const PLAN_MODE_WRITE_BLOCK_REASON =
  "计划模式下禁止修改操作。请先完善计划并调用 ExitPlanMode 获得用户批准;批准后写工具自动恢复。";

// ---------------------------------------------------------------------------
// bash 只读白名单
// ---------------------------------------------------------------------------

/** 直接只读的命令(首词命中即该段安全)。
 *  注意:env/less/more 不在列——env 能执行任意程序(env rm -rf x 逃逸),
 *  less/more 支持 !cmd 交互执行;读环境变量请用 printenv。 */
const SAFE_BINARIES = new Set([
  "cat", "head", "tail",
  "grep", "egrep", "fgrep", "rg", "ag",
  "find", "fd", "ls", "pwd", "tree", "wc", "file", "stat",
  "echo", "printf", "printenv", "which", "type",
  "whoami", "date", "uname", "uptime", "hostname",
  "sort", "uniq", "comm", "diff", "cut", "tr", "jq", "yq",
  "du", "df", "basename", "dirname", "realpath", "readlink",
  "cd", "true",
]);

/** git 只允许这些只读子命令 */
const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "branch", "tag", "blame",
  "rev-parse", "describe", "remote", "ls-files", "ls-tree",
  "shortlog", "reflog", "grep", "config", "stash", "rev-list",
]);

/** npm/pnpm/yarn 只允许这些查询子命令 */
const SAFE_PKG_SUBCOMMANDS = new Set([
  "list", "ls", "outdated", "view", "info", "why", "bin", "root", "prefix", "audit",
]);

/** 段分隔符:管道、与或、分号 */
const SEGMENT_SPLIT = /\|\||&&|[|;]/;

/** find 的这些旗标能删文件/执行命令/写文件,命中即不安全 */
const DANGEROUS_FIND_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprintf"]);

/**
 * 计划态 bash 命令安全性判定。
 * 按管道/连接符拆段,逐段检查首词(及其子命令)是否在只读白名单内;
 * 命令替换与输出重定向一律拒绝(它们能藏写操作)。
 */
export function isPlanModeSafeCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  // 命令替换 $(...) / `...` 与重定向 > >> 直接拒绝
  if (/`|\$\(/.test(cmd)) return false;
  if(/(^|\s)>>?/.test(cmd)) return false;
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
      }
      continue;
    }
    if (bin === "npm" || bin === "pnpm" || bin === "yarn") {
      const sub = tokens.slice(1).find((t) => !t.startsWith("-"));
      if (!sub || !SAFE_PKG_SUBCOMMANDS.has(sub)) return false;
      continue;
    }
    return false;
  }
  return true;
}
