/**
 * 权限网关（beforeToolCall）的统一实现：计划模式门禁 → 文件路径守卫 → 风险分级 → 沙盒联动。
 *
 * 从 session-controller 抽出独立模块的原因（评审 R3-C4）：Task 子代理的会话
 * 与主会话共享同一套裁决链——子代理此前不挂网关，edit/write 可无审批写任意文件
 * （记忆投毒面）。现在主会话与子代理都调 createBeforeToolCallGate，唯一差别是
 * 子代理永远不在计划模式（计划模式下 Task 工具本身不挂载）。
 */
import { randomUUID } from "node:crypto";
import type { PermissionRequest, SandboxSettings } from "@spcode/shared";
import { isPlanModeSafeCommand, PLAN_MODE_BASH_BLOCK_REASON, PLAN_MODE_WRITE_BLOCK_REASON } from "./plan-mode.js";
import { matchesExcludedCommand } from "./sandbox/bash-tool.js";
import { type FsGuardPolicy, judgeFsToolCall } from "./sandbox/fs-guard.js";
import type { SandboxState } from "./sandbox/manager.js";
import { classifyToolRisk, extractCommand, READONLY_TOOLS } from "./session-controller.js";

/** pi beforeToolCall 钩子的上下文结构（只用到 toolCall 的 name/arguments） */
export interface BeforeToolCallCtx {
  toolCall: { name: string; arguments?: unknown };
}

export type ToolCallVerdict = { block: true; reason: string } | undefined;

export interface PermissionGateDeps {
  sessionId: string;
  /** 实时读取计划模式状态（子代理恒 false） */
  isPlanMode: () => boolean;
  /** 实时读取文件路径守卫策略（cwd/敏感清单） */
  getFsPolicy: () => FsGuardPolicy;
  /** 实时读取沙盒设置（excludedCommands/allowUnsandboxedCommands 热生效） */
  getSandboxSettings?: () => SandboxSettings;
  /** 会话创建时的沙盒状态（与 bash 工具注册同生命周期，中途不变） */
  sandboxState: SandboxState;
  requestPermission: (req: PermissionRequest) => Promise<boolean>;
}

const DENIED_BY_USER = "User denied this tool call in Spcod permission dialog.";

export function createBeforeToolCallGate(deps: PermissionGateDeps) {
  return async (ctx: BeforeToolCallCtx): Promise<ToolCallVerdict> => {
    const toolName = ctx.toolCall.name.toLowerCase();

    // 计划模式门禁（实时读取，运行中切换也立即生效）：
    // bash 走只读白名单；写类调用本不该出现在计划工具集里，兜底拦截
    if (deps.isPlanMode()) {
      if (toolName === "bash" || toolName === "powershell") {
        const cmd = extractCommand(ctx.toolCall.arguments);
        if (cmd && isPlanModeSafeCommand(cmd)) return undefined;
        return { block: true, reason: PLAN_MODE_BASH_BLOCK_REASON };
      }
      if (!READONLY_TOOLS.has(toolName)) {
        return { block: true, reason: PLAN_MODE_WRITE_BLOCK_REASON };
      }
      return undefined;
    }

    // 文件路径守卫（R3-C3）：deny 硬拦；prompt 走 danger 级弹窗（任何权限模式都弹）。
    const fsVerdict = judgeFsToolCall(ctx.toolCall.name, ctx.toolCall.arguments, deps.getFsPolicy());
    if (fsVerdict?.action === "deny") {
      return { block: true, reason: `Spcode path policy: ${fsVerdict.reason}` };
    }
    if (fsVerdict?.action === "prompt") {
      const approved = await deps.requestPermission({
        requestId: randomUUID(),
        sessionId: deps.sessionId,
        toolName: ctx.toolCall.name,
        args: ctx.toolCall.arguments,
        risk: "danger",
        sandboxed: false,
      });
      return approved ? undefined : { block: true, reason: DENIED_BY_USER };
    }

    const risk = classifyToolRisk(ctx.toolCall.name, ctx.toolCall.arguments);
    if (risk === "readonly") return undefined;

    // 沙盒联动（创建时固定，与工具注册同生命周期）：
    // - 仅 bash/powershell 受沙盒约束；edit/write 等进程内文件工具由上面的路径守卫约束
    // - 沙盒内 write 级命令在 autoAllow 开启时免审批（内核边界已兜底）
    // - outward（对外动作）/danger 仍弹窗——沙盒管不住语义级后果
    // - 逃生舱（dangerouslyDisableSandbox=true）：严格模式直接拒；否则强制弹窗（bypass 标记），
    //   不享受 autoAllow——批准后命令在沙盒外以完整权限执行
    // - excludedCommands（沙盒外白名单）命中的命令不经沙盒，不享受 autoAllow，走普通权限流
    const sandboxed = deps.sandboxState.state === "active";
    const isShellTool = toolName === "bash" || toolName === "powershell";
    const sandboxSettings = deps.getSandboxSettings?.();
    const bypassRequested =
      isShellTool &&
      sandboxed &&
      (ctx.toolCall.arguments as { dangerouslyDisableSandbox?: unknown } | null)?.dangerouslyDisableSandbox === true;
    if (bypassRequested) {
      if (!sandboxSettings?.allowUnsandboxedCommands) {
        return {
          block: true,
          reason:
            "Sandbox strict mode: dangerouslyDisableSandbox is disabled (sandbox.allowUnsandboxedCommands=false). Run the command inside the sandbox or ask the user to allow it in Settings → Sandbox.",
        };
      }
      const approved = await deps.requestPermission({
        requestId: randomUUID(),
        sessionId: deps.sessionId,
        toolName: ctx.toolCall.name,
        args: ctx.toolCall.arguments,
        risk,
        sandboxed: false,
        bypass: true,
      });
      return approved ? undefined : { block: true, reason: DENIED_BY_USER };
    }
    const cmd = extractCommand(ctx.toolCall.arguments);
    const excludedHit =
      isShellTool &&
      sandboxed &&
      cmd !== null &&
      (sandboxSettings?.excludedCommands ?? []).some((r) => matchesExcludedCommand(cmd, r));
    const effectiveSandboxed = sandboxed && isShellTool && !excludedHit;
    if (effectiveSandboxed && risk === "write" && sandboxSettings?.autoAllow) {
      return undefined;
    }
    const approved = await deps.requestPermission({
      requestId: randomUUID(),
      sessionId: deps.sessionId,
      toolName: ctx.toolCall.name,
      args: ctx.toolCall.arguments,
      risk,
      sandboxed: effectiveSandboxed,
    });
    return approved ? undefined : { block: true, reason: DENIED_BY_USER };
  };
}
