/**
 * 沙盒化 bash 工具 —— 以同名 customTool 覆盖 pi 内置 bash。
 *
 * pi 的工具注册表语义：customTools 与内置工具同名时 customTools 生效
 * （_refreshToolRegistry 中后写覆盖）。因此这里用 createBashToolDefinition
 * 保留内置工具的全部行为（流式输出、截断、进程树终止、超时），
 * 只把执行后端 operations.exec 替换为「先 SandboxManager.wrapWithSandbox
 * 包装，再委托 pi 原生本地执行」。
 *
 * 逃生舱（对齐 Claude Code 的 dangerouslyDisableSandbox）：
 * - 工具 schema 扩展 dangerouslyDisableSandbox?: boolean。为 true 时经一个独立的
 *   纯本地 ToolDefinition 执行（不经 wrap、不写违规归因）——是否批准由 beforeToolCall
 *   权限网关强制弹窗裁决，这里不重复问（双实例而非参数下传，避免并行调用串扰）。
 * - excludedCommands（设置页「沙盒外白名单」/权限卡「总允许」沉淀）前缀命中的命令
 *   直接裸跑，走普通权限流。
 * - 子代理（Task）注册的版本 allowBypass=false：schema 里根本没有逃生舱参数——
 *   子会话不挂权限网关，开了就是无审批逃逸口。
 *
 * 工具描述里向模型声明沙盒边界的存在——被拦截时模型能理解 EPERM/网络错误
 * 是预期行为并如实告知用户，而不是盲目重试。
 */
import {
  type BashOperations,
  createBashToolDefinition,
  createLocalBashOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { SandboxSettings } from "@spcode/shared";
import { Type } from "typebox";
import { getSandboxService } from "./manager.js";

const SANDBOX_DESCRIPTION_NOTE =
  " Commands run inside an OS-enforced sandbox: writes are restricted to the working directory and system temp dirs, sensitive paths (~/.ssh, app credentials) are unreadable, and network access is limited to an allowlist of domains. If a command fails with EPERM / 'Operation not permitted' / 'Could not resolve host', it was blocked by the sandbox — do not retry blindly; report the restriction to the user.";

const BYPASS_DESCRIPTION_NOTE =
  " If a command is fundamentally incompatible with the sandbox (launching GUI/Electron apps, keychain or Mach service access, raw sockets), retry it with dangerouslyDisableSandbox=true — the user will be asked to approve running it outside the sandbox. Never use this to work around writable-path or credential restrictions.";

/** 违规注解尾部标记，渲染层/测试可据此识别 */
export const SANDBOX_VIOLATION_NOTE_HEADER = "[sandbox] restrictions hit during this command:";

/** 违规归因后的逃生舱引导（仅在逃生舱开放时追加） */
const BYPASS_HINT =
  "If this command is fundamentally incompatible with the sandbox (GUI/Electron app, keychain, Mach services), retry with dangerouslyDisableSandbox=true — the user will be asked to approve.";

/** 逃生舱开放时的扩展 schema（bypass 参数描述即模型的使用契约） */
const sandboxedBashSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
  dangerouslyDisableSandbox: Type.Optional(
    Type.Boolean({
      description:
        "Set true ONLY if the command fundamentally cannot work inside the OS sandbox (e.g. launching GUI/Electron apps, keychain/Mach access). The command will run outside the sandbox with full user permissions after explicit user approval.",
    }),
  ),
});

/** 含 shell 元字符的复合命令一律不匹配（与主进程 matchesPermissionRule 同语义，评审 R3-C5） */
const SHELL_METACHARS = /[;|&<>\n`$]/;

/** excludedCommands 前缀匹配（token 边界）；复合命令不适用白名单（整条都会在沙盒外执行） */
export function matchesExcludedCommand(command: string, rule: string): boolean {
  const r = rule.trim().replace(/\s+/g, " ");
  if (!r) return false;
  if (SHELL_METACHARS.test(command)) return false; // 必须在空白归一前判（\n 会被归一成空格）
  const cmd = command.trim().replace(/\s+/g, " ");
  if (!cmd) return false;
  return cmd === r || (cmd.startsWith(r) && cmd[r.length] === " ");
}

export interface SandboxedBashToolOptions {
  /** 是否暴露 dangerouslyDisableSandbox 逃生舱参数（子代理必须 false） */
  allowBypass: boolean;
  /** 实时读取沙盒设置（excludedCommands/allowUnsandboxedCommands 热生效）；缺省用服务快照 */
  getSettings?: () => SandboxSettings;
}

export function createSandboxedBashTool(cwd: string, opts: SandboxedBashToolOptions): ToolDefinition {
  const sandbox = getSandboxService();
  const local = createLocalBashOperations();
  const allowBypass = opts.allowBypass;
  const getSettings = () => opts.getSettings?.() ?? sandbox.settingsSnapshot();

  const sandboxedOps: BashOperations = {
    exec: async (command, execCwd, options) => {
      // 沙盒外白名单：命中直接裸跑（权限流已在网关侧按无沙盒处理）
      const excluded = getSettings().excludedCommands ?? [];
      if (excluded.some((r) => matchesExcludedCommand(command, r))) {
        return local.exec(command, execCwd, options);
      }
      let wrapped: string;
      let commandId: string;
      try {
        ({ command: wrapped, commandId } = await sandbox.wrap(command, execCwd));
      } catch (err) {
        // fail-closed：包装失败绝不裸跑（那等于静默关闭沙盒）
        const message = err instanceof Error ? err.message : String(err);
        options.onData(
          Buffer.from(
            `Command not executed: sandbox wrapping failed (${message}). ` +
              `You may retry; if it persists, ask the user to check sandbox status in Settings.\n`,
          ),
        );
        return { exitCode: 126 };
      }
      const result = await local.exec(wrapped, execCwd, options);
      // 违规归因：把内核/代理拦截记录附到输出尾部，模型据此理解并回应
      const violations = sandbox.violations(commandId);
      if (violations.length > 0) {
        const lines = violations.map((v) => `  ${v.line}`).join("\n");
        const hint = allowBypass && getSettings().allowUnsandboxedCommands ? `\n${BYPASS_HINT}` : "";
        options.onData(Buffer.from(`\n${SANDBOX_VIOLATION_NOTE_HEADER}\n${lines}${hint}\n`));
      }
      return result;
    },
  };

  const sandboxedDef = createBashToolDefinition(cwd, { operations: sandboxedOps });
  // 逃生舱执行路径：独立的纯本地定义（默认 local ops），与沙盒路径零共享状态
  const unsandboxedDef = allowBypass ? createBashToolDefinition(cwd, {}) : null;

  // 泛型方差：createBashToolDefinition 返回的是参数特化的 ToolDefinition，
  // 与注册表要求的通用 ToolDefinition 不直接相容，这里断言收窄（运行时结构一致）
  return {
    ...sandboxedDef,
    description: sandboxedDef.description + SANDBOX_DESCRIPTION_NOTE + (allowBypass ? BYPASS_DESCRIPTION_NOTE : ""),
    promptGuidelines: [
      ...(sandboxedDef.promptGuidelines ?? []),
      "Commands are sandboxed: filesystem writes outside the working directory and network access to non-allowlisted domains will be blocked by the OS.",
    ],
    parameters: allowBypass ? sandboxedBashSchema : sandboxedDef.parameters,
    execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: never, ctx: never) => {
      const p = params as { command: string; timeout?: number; dangerouslyDisableSandbox?: boolean };
      if (p.dangerouslyDisableSandbox === true && unsandboxedDef) {
        // 网关已批准（beforeToolCall 强制弹窗）；剥掉 flag 走纯本地执行
        return unsandboxedDef.execute(toolCallId, { command: p.command, timeout: p.timeout }, signal, onUpdate, ctx);
      }
      return sandboxedDef.execute(toolCallId, { command: p.command, timeout: p.timeout }, signal, onUpdate, ctx);
    },
  } as unknown as ToolDefinition;
}
