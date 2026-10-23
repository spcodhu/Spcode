/**
 * 运行状态推导（纯逻辑，无 UI 依赖；组件在 components/RunStatusBar.tsx）。
 *
 * 背景：运行头（"正在工作…"）与时间线工具行都在消息流里，多轮思考/调用后
 * 被滚出视口。这里从 store 数据推导「模型现在在干嘛」，供常驻状态条渲染。
 */

import type { PermissionRequest, QuestionRequest } from "@spcode/shared";
import { i18n } from "@spcode/shared/i18n";
import type { SessionState } from "./store";
import { isCommandTool, summarizeArgs, toolLabel } from "./tooling";

export interface RunStatus {
  kind: "thinking" | "tool" | "text" | "working" | "permission" | "question" | "retry";
  /** 主文案（如「思考中…」「正在改文件」） */
  label: string;
  /** 工具参数摘要（kind === "tool" 时可能有） */
  detail?: string;
}

/**
 * 状态推导：
 * 优先级：待答提问 > 待批权限 > 自动重试 > 当前阶段（思考/工具/输出/回合间隙）。
 */
export function deriveRunStatus(
  session: SessionState | undefined,
  pendingPermissions: PermissionRequest[],
  pendingQuestions: QuestionRequest[],
  sessionId: string,
): RunStatus | null {
  if (session?.compacting) return { kind: "working", label: i18n.t("chat:run.compacting") };
  if (!session?.running) return null;
  if (pendingQuestions.some((q) => q.sessionId === sessionId)) {
    return { kind: "question", label: i18n.t("chat:run.question") };
  }
  const perm = pendingPermissions.find((p) => p.sessionId === sessionId);
  if (perm) {
    return { kind: "permission", label: i18n.t("chat:run.permission", { tool: toolLabel(perm.toolName) }) };
  }
  // 引擎自动重试（额度/限流/网络抖动）：不显示的话用户只会看到界面卡住
  if (session.retry) {
    const secs = Math.max(1, Math.ceil(session.retry.delayMs / 1000));
    return {
      kind: "retry",
      label: i18n.t("chat:run.retry", {
        seconds: secs,
        attempt: session.retry.attempt,
        maxAttempts: session.retry.maxAttempts,
      }),
      detail: shortReason(session.retry.errorMessage),
    };
  }
  const last = session.messages[session.messages.length - 1];
  // 回合间隙（上一条消息已定格，下一回合未开始）或无消息：兜底「正在工作…」
  if (last?.role !== "assistant" || !last?.streaming) return { kind: "working", label: i18n.t("chat:run.working") };
  const seg = last.segments[last.segments.length - 1];
  if (!seg) return { kind: "working", label: i18n.t("chat:run.working") };
  if (seg.kind === "thinking" && !seg.done) return { kind: "thinking", label: i18n.t("chat:run.thinking") };
  if (seg.kind === "tools") {
    const running = [...seg.calls].reverse().find((c) => c.status === "running");
    if (running) {
      const detail = summarizeArgs(running.name, running.args);
      const label = isCommandTool(running.name)
        ? i18n.t("chat:run.command")
        : i18n.t("chat:run.tool", { tool: toolLabel(running.name) });
      return { kind: "tool", label, detail: detail || undefined };
    }
    return { kind: "working", label: i18n.t("chat:run.working") };
  }
  if (seg.kind === "text") return { kind: "text", label: i18n.t("chat:run.output") };
  // 末段是已完成的思考：下一动作未到，按工作间隙处理
  return { kind: "working", label: i18n.t("chat:run.working") };
}

/**
 * 底部常驻状态条是否显示：思考/工具/输出/回合间隙已经由消息流里的
 * Qoder 活动组与「继续思考中…」表达，不再重复；只有消息流之外的
 * 例外状态（上下文压缩、等待权限/回答、自动重试）才显示。
 */
export function shouldShowRunStatusBar(session: SessionState | undefined, status: RunStatus | null): boolean {
  if (!status) return false;
  if (session?.compacting) return true;
  return status.kind === "permission" || status.kind === "question" || status.kind === "retry";
}

/** 错误原因精简：去首行/去 provider 前缀噪声，供状态条同行展示（完整内容在错误卡） */
export function shortReason(message: string, max = 60): string {
  const line = message.split("\n").find((l) => l.trim()) ?? "";
  const trimmed = line.trim().replace(/^\w*Error:\s*/i, "");
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** 耗时格式化：12s / 1:05 */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return i18n.t("chat:run.seconds", { seconds });
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
