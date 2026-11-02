/**
 * 权限裁决矩阵（纯函数，零 I/O，宿主与主进程共用同一份实现）。
 *
 * 分工原则：
 * - **权限模式决定"问不问"**（应用层，本文件）；
 * - **沙盒决定"拦不拦"**（内核层，seatbelt/bubblewrap 强制执行，模式管不到）；
 * - **逃生舱**（dangerouslyDisableSandbox）是唯一同时改变两者的动作，所以单独占一行——
 *   它是任何模式下唯一保留的人工确认点（沙盒外执行等于放弃内核边界）。
 *
 * 三档语义：
 * - `ask`   总是询问：只读放行，写/对外/危险一律弹窗（沙盒内也一样）。
 * - `auto`  必要时询问：写类放行（含沙盒外，取决于用户对"无内核兜底"的接受度），
 *           对外动作与不可逆操作仍弹窗——沙盒管不住语义级后果。
 * - `never` 总不询问：除逃生舱外全部放行（含对外/危险/网络白名单外域名）。
 *           沙盒边界、凭据禁读、计划模式门禁仍然生效，只是不再弹窗。
 *
 * 不由本函数决定的三类硬闸（调用方在矩阵之前处理）：
 * 计划模式门禁、文件路径守卫的 `deny`（凭据区）、沙盒包装失败（fail-closed）。
 */

export type ToolRisk = "readonly" | "write" | "outward" | "danger";

export type PermissionMode = "ask" | "auto" | "never";

export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "auto", "never"];

/** 新会话默认档位：最保守的一档（历史行为保持） */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "ask";

/**
 * 旧值迁移：`act` 与 `auto` 语义等同（"仅危险命令确认"）。
 * 返回 null 表示非法值，调用方应剔除并回落默认。
 */
export function normalizePermissionMode(value: unknown): PermissionMode | null {
  if (value === "ask" || value === "auto" || value === "never") return value;
  if (value === "act") return "auto";
  return null;
}

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  toolName: string;
  args: unknown;
  risk: ToolRisk;
  /** 项目工作目录（项目级权限白名单按此隔离；网络等无项目上下文的请求可缺省） */
  cwd?: string;
  /** 该命令是否将在 OS 沙盒内执行（渲染层据此标注「沙盒内」；false/缺省 = 无沙盒兜底） */
  sandboxed?: boolean;
  /** 逃生舱请求：模型申请在沙盒外执行（dangerouslyDisableSandbox）。渲染层据此强警示——不受文件/网络边界约束 */
  bypass?: boolean;
}

/** 项目级免审批规则：普通命令可记同类前缀，危险/复合命令只能记完整命令。 */
export interface ProjectPermissionRule {
  command: string;
  match: "prefix" | "exact";
}

/** 项目键归一：统一分隔符并去尾部斜线；Windows 根路径也稳定映射到同一键。 */
export function normalizeProjectCwd(cwd: string): string {
  const slashed = cwd.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!slashed) return "";
  return slashed.replace(/\/+$/, "") || "/";
}

const SHELL_UNSUPPORTED_PREFIX = /[<>`$]/;

function shellCommand(args: unknown): string | null {
  if (!args || typeof args !== "object" || !("command" in args)) return null;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : null;
}

interface ParsedShellCommand {
  segments: string[];
  /** 顶层存在 ; & | 或换行分隔符（引号内不算） */
  compound: boolean;
}

/**
 * 只做权限规则需要的保守分段：识别引号/转义，按顶层 ; & | 与换行切分。
 * 命令替换、重定向等无法可靠证明语义的结构返回 null，调用方回退为整条 exact。
 */
function parseShellCommand(command: string): ParsedShellCommand | null {
  if (SHELL_UNSUPPORTED_PREFIX.test(command)) return null;
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let compound = false;

  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") {
      compound = true;
      const segment = current.trim();
      if (segment) segments.push(segment);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote || escaped) return null;
  const tail = current.trim();
  if (tail) segments.push(tail);
  return segments.length > 0 ? { segments, compound } : null;
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/** 普通命令记前两个 token 作为同类前缀；单个 token 命令记自身。 */
function prefixRuleOf(segment: string): ProjectPermissionRule {
  const tokens = normalizeCommand(segment).split(" ");
  return { command: tokens.length >= 2 ? tokens.slice(0, 2).join(" ") : tokens[0]!, match: "prefix" };
}

/** 从真实待决请求生成项目规则；bypass 永不生成免审批规则。 */
export function deriveProjectPermissionRules(
  request: Pick<PermissionRequest, "toolName" | "args" | "risk" | "bypass" | "cwd">,
): ProjectPermissionRule[] {
  if (request.bypass || !normalizeProjectCwd(request.cwd ?? "")) return [];
  const tool = request.toolName.toLowerCase();
  if (tool !== "bash" && tool !== "powershell") return [];
  const raw = shellCommand(request.args)?.trim();
  if (!raw) return [];
  // 危险命令只能逐字复用同一完整命令，绝不生成前缀
  if (request.risk === "danger") return [{ command: raw, match: "exact" }];

  const parsed = parseShellCommand(raw);
  if (!parsed || (parsed.compound && parsed.segments.length < 2)) {
    return [{ command: raw, match: "exact" }];
  }
  // 复合命令按段沉淀：git add x && git push y → git add + git push；
  // 后续整链必须每段都有规则覆盖，绝不因首段命中而放行未知尾段。
  const rules = parsed.segments.map(prefixRuleOf);
  return [...new Map(rules.map((rule) => [`${rule.match}:${rule.command}`, rule])).values()];
}

/** 旧 API：单规则推导。新代码应使用 deriveProjectPermissionRules 以覆盖复合命令。 */
export function deriveProjectPermissionRule(
  request: Pick<PermissionRequest, "toolName" | "args" | "risk" | "bypass" | "cwd">,
): ProjectPermissionRule | null {
  return deriveProjectPermissionRules(request)[0] ?? null;
}

function matchesPrefix(command: string, prefix: string): boolean {
  const cmd = normalizeCommand(command);
  const normalizedPrefix = normalizeCommand(prefix);
  if (!cmd || !normalizedPrefix) return false;
  return cmd === normalizedPrefix || (cmd.startsWith(normalizedPrefix) && cmd[normalizedPrefix.length] === " ");
}

/** 项目规则匹配：exact 逐字相同；prefix 要求 token 边界。复合命令需每段都有规则。 */
export function matchesProjectPermissionRules(command: string, rules: ProjectPermissionRule[]): boolean {
  const cmd = command.trim();
  if (!cmd || rules.length === 0) return false;
  // 旧版已保存的整条 exact 规则继续有效（不自动扩成前缀）
  if (rules.some((rule) => rule.match === "exact" && cmd === rule.command.trim())) return true;

  const parsed = parseShellCommand(cmd);
  if (!parsed) return false;
  return parsed.segments.every((segment) =>
    rules.some((rule) => rule.match === "prefix" && matchesPrefix(segment, rule.command)),
  );
}

/** 单规则匹配（旧全局规则兼容）；复合命令同样要求所有命令段被该规则覆盖。 */
export function matchesProjectPermissionRule(command: string, rule: ProjectPermissionRule): boolean {
  return matchesProjectPermissionRules(command, [rule]);
}

/** 逃生舱被设置关闭（sandbox.allowUnsandboxedCommands=false）时的规范拒绝原因 */
export const BYPASS_DISABLED_REASON =
  "Sandbox strict mode: dangerouslyDisableSandbox is disabled (sandbox.allowUnsandboxedCommands=false). Run the command inside the sandbox or ask the user to allow it in Settings → Sandbox.";

export type PermissionVerdict =
  | { action: "allow" }
  | { action: "ask" }
  | { action: "block"; reason: string; reasonKey: "main:permission.sandboxStrict" };

export interface DecidePermissionInput {
  /** 已分级风险（调用方用 classifyToolRisk 得出） */
  risk: ToolRisk;
  /** 当前会话的权限模式 */
  mode: PermissionMode;
  /** 模型申请沙盒外执行（逃生舱） */
  bypass?: boolean;
  /** 逃生舱被设置关闭：任何模式都直接拒 */
  bypassDisabled?: boolean;
}

/**
 * 矩阵本体。注意：`sandboxed` 不参与判定——模式决定问不问，沙盒决定拦不拦，
 * 两者正交。沙盒开/关只会改变"被拦时的表现"（EPERM 而非弹窗），不改变此处结果。
 */
export function decidePermissionMatrix({
  risk,
  mode,
  bypass = false,
  bypassDisabled = false,
}: DecidePermissionInput): PermissionVerdict {
  if (bypass) {
    if (bypassDisabled) {
      return { action: "block", reason: BYPASS_DISABLED_REASON, reasonKey: "main:permission.sandboxStrict" };
    }
    // 三档都要问：这是唯一会移除内核边界的动作
    return { action: "ask" };
  }
  if (risk === "readonly") return { action: "allow" };
  if (mode === "never") return { action: "allow" };
  // auto：写类放行（沙盒内外的差别由沙盒自己承担），对外/危险仍问
  if (mode === "auto" && risk === "write") return { action: "allow" };
  return { action: "ask" };
}

/** 三档的中文短名（日志/审计用；UI 文案走 i18n） */
export function permissionModeLabel(mode: PermissionMode): string {
  return mode === "ask" ? "总是询问" : mode === "auto" ? "必要时询问" : "总不询问";
}
