/**
 * 权限网关（beforeToolCall）的统一实现：计划模式门禁 → 文件路径守卫 → 权限模式矩阵。
 *
 * 从 session-controller 抽出独立模块的原因（评审 R3-C4）：Task 子代理的会话
 * 与主会话共享同一套裁决链——子代理此前不挂网关，edit/write 可无审批写任意文件
 * （记忆投毒面）。现在主会话与子代理都调 createBeforeToolCallGate，唯一差别是
 * 子代理永远不在计划模式（计划模式下 Task 工具本身不挂载）。
 *
 * 三档权限模式（总是询问/必要时询问/总不询问）的判定下沉到 shared 的纯函数
 * decidePermissionMatrix：模式决定"问不问"，沙盒决定"拦不拦"，两者正交。
 * 本文件只负责在矩阵前后摆好三道硬闸（计划模式、凭据区、逃生舱严格模式）
 * 与权限请求的组装。
 */
import { randomUUID } from "node:crypto";
import {
  decidePermissionMatrix,
  type PermissionMode,
  type PermissionRequest,
  type SandboxSettings,
} from "@spcode/shared";
import type { LocalizedText } from "@spcode/shared/i18n";
import { isPlanModeSafeCommand, PLAN_MODE_BASH_BLOCK_REASON, PLAN_MODE_WRITE_BLOCK_REASON } from "./plan-mode.js";
import { matchesExcludedCommand } from "./sandbox/bash-tool.js";
import { type FsGuardPolicy, judgeFsToolCall } from "./sandbox/fs-guard.js";
import type { SandboxState } from "./sandbox/manager.js";
import { classifyToolRisk, extractCommand, READONLY_TOOLS } from "./session-controller.js";

/** pi beforeToolCall 钩子的上下文结构（只用到 toolCall 的 name/arguments） */
export interface BeforeToolCallCtx {
  toolCall: { name: string; arguments?: unknown };
}

/** Keep model-facing reasons canonical; render reasonMessage at the UI boundary. */
export type ToolCallVerdict = { block: true; reason: string; reasonMessage?: LocalizedText } | undefined;

export interface PermissionGateDeps {
  sessionId: string;
  /** 实时读取计划模式状态（子代理恒 false） */
  isPlanMode: () => boolean;
  /** 实时读取当前会话的权限模式（三档，运行中切换立即生效）；缺省按最保守的「总是询问」 */
  getPermissionMode?: () => PermissionMode;
  /** 实时读取文件路径守卫策略（cwd/敏感清单） */
  getFsPolicy: () => FsGuardPolicy;
  /** 实时读取沙盒设置（excludedCommands/allowUnsandboxedCommands 热生效） */
  getSandboxSettings?: () => SandboxSettings;
  /** 会话创建时的沙盒状态（与 bash 工具注册同生命周期，中途不变） */
  sandboxState: SandboxState;
  requestPermission: (req: PermissionRequest) => Promise<boolean>;
}

const DENIED_BY_USER = "User denied this tool call in Spcod permission dialog.";
const DENIED_MESSAGE: LocalizedText = { key: "main:permission.denied" };

export function createBeforeToolCallGate(deps: PermissionGateDeps) {
  return async (ctx: BeforeToolCallCtx): Promise<ToolCallVerdict> => {
    const toolName = ctx.toolCall.name.toLowerCase();
    const mode: PermissionMode = deps.getPermissionMode?.() ?? "ask";

    // 计划模式门禁（实时读取，运行中切换也立即生效），三档模式下都是硬闸：
    // bash 走只读白名单；写类调用本不该出现在计划工具集里，兜底拦截
    if (deps.isPlanMode()) {
      if (toolName === "bash" || toolName === "powershell") {
        const cmd = extractCommand(ctx.toolCall.arguments);
        if (cmd && isPlanModeSafeCommand(cmd)) return undefined;
        return { block: true, reason: PLAN_MODE_BASH_BLOCK_REASON, reasonMessage: { key: "main:permission.planBash" } };
      }
      if (!READONLY_TOOLS.has(toolName)) {
        return {
          block: true,
          reason: PLAN_MODE_WRITE_BLOCK_REASON,
          reasonMessage: { key: "main:permission.planWrite" },
        };
      }
      return undefined;
    }

    // 文件路径守卫（R3-C3）：deny 硬拦（三档都不放开，凭据区是底线）；
    // prompt 按 danger 级风险参与矩阵——「总不询问」档自动放行，「总是/必要时」弹窗。
    const fsPolicy = deps.getFsPolicy();
    const fsVerdict = judgeFsToolCall(ctx.toolCall.name, ctx.toolCall.arguments, fsPolicy);
    if (fsVerdict?.action === "deny") {
      return { block: true, reason: `Spcode path policy: ${fsVerdict.reason}`, reasonMessage: fsVerdict.reasonMessage };
    }
    if (fsVerdict?.action === "prompt") {
      if (decidePermissionMatrix({ risk: "danger", mode }).action === "allow") return undefined;
      const approved = await deps.requestPermission({
        requestId: randomUUID(),
        sessionId: deps.sessionId,
        toolName: ctx.toolCall.name,
        args: ctx.toolCall.arguments,
        risk: "danger",
        cwd: fsPolicy.cwd,
        sandboxed: false,
      });
      return approved ? undefined : { block: true, reason: DENIED_BY_USER, reasonMessage: DENIED_MESSAGE };
    }

    // 沙盒联动（创建时固定，与工具注册同生命周期）：
    // - 仅 bash/powershell 受沙盒约束；edit/write 等进程内文件工具由上面的路径守卫约束
    // - excludedCommands（沙盒外白名单）命中的命令不经沙盒，卡片上不再标「沙盒内」
    // - 逃生舱（dangerouslyDisableSandbox=true）：三档模式都要弹窗；设置关闭则直接拒
    const sandboxed = deps.sandboxState.state === "active";
    const isShellTool = toolName === "bash" || toolName === "powershell";
    const sandboxSettings = deps.getSandboxSettings?.();
    const bypassRequested =
      isShellTool &&
      sandboxed &&
      (ctx.toolCall.arguments as { dangerouslyDisableSandbox?: unknown } | null)?.dangerouslyDisableSandbox === true;
    const cmd = extractCommand(ctx.toolCall.arguments);
    const excludedHit =
      isShellTool &&
      sandboxed &&
      cmd !== null &&
      (sandboxSettings?.excludedCommands ?? []).some((r) => matchesExcludedCommand(cmd, r));
    const effectiveSandboxed = sandboxed && isShellTool && !excludedHit;

    const risk = classifyToolRisk(ctx.toolCall.name, ctx.toolCall.arguments);
    const verdict = decidePermissionMatrix({
      risk,
      mode,
      bypass: bypassRequested,
      bypassDisabled: !sandboxSettings?.allowUnsandboxedCommands,
    });
    if (verdict.action === "allow") return undefined;
    if (verdict.action === "block") {
      return { block: true, reason: verdict.reason, reasonMessage: { key: verdict.reasonKey } };
    }
    const approved = await deps.requestPermission({
      requestId: randomUUID(),
      sessionId: deps.sessionId,
      toolName: ctx.toolCall.name,
      args: ctx.toolCall.arguments,
      risk,
      cwd: fsPolicy.cwd,
      // 逃生舱请求最终会在沙盒外执行，卡片不能标「沙盒内」
      sandboxed: effectiveSandboxed && !bypassRequested,
      bypass: bypassRequested || undefined,
    });
    return approved ? undefined : { block: true, reason: DENIED_BY_USER, reasonMessage: DENIED_MESSAGE };
  };
}
