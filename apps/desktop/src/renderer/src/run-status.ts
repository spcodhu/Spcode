/**
 * 运行状态推导（纯逻辑，无 UI 依赖；组件在 components/RunStatusBar.tsx）。
 *
 * 背景：运行头（"正在工作…"）与时间线工具行都在消息流里，多轮思考/调用后
 * 被滚出视口。这里从 store 数据推导「模型现在在干嘛」，供常驻状态条渲染。
 */

import type { PermissionRequest, QuestionRequest } from "@spcode/shared";
import type { SessionState } from "./store";
import { summarizeArgs, toolLabel } from "./tooling";

export interface RunStatus {
  kind: "thinking" | "tool" | "text" | "working" | "permission" | "question";
  /** 主文案（如「思考中…」「正在改文件」） */
  label: string;
  /** 工具参数摘要（kind === "tool" 时可能有） */
  detail?: string;
}

/**
 * 状态推导：
 * 优先级：待答提问 > 待批权限 > 当前阶段（思考/工具/输出/回合间隙）。
 */
export function deriveRunStatus(
  session: SessionState | undefined,
  pendingPermissions: PermissionRequest[],
  pendingQuestions: QuestionRequest[],
  sessionId: string,
): RunStatus | null {
  if (session?.compacting) return { kind: "working", label: "正在压缩上下文…" };
  if (!session?.running) return null;
  if (pendingQuestions.some((q) => q.sessionId === sessionId)) {
    return { kind: "question", label: "等待你的回答…" };
  }
  const perm = pendingPermissions.find((p) => p.sessionId === sessionId);
  if (perm) {
    return { kind: "permission", label: `等待权限确认 · ${toolLabel(perm.toolName)}` };
  }
  const last = session.messages[session.messages.length - 1];
  // 回合间隙（上一条消息已定格，下一回合未开始）或无消息：兜底「正在工作…」
  if (!last || last.role !== "assistant" || !last.streaming) return { kind: "working", label: "正在工作…" };
  const seg = last.segments[last.segments.length - 1];
  if (!seg) return { kind: "working", label: "正在工作…" };
  if (seg.kind === "thinking" && !seg.done) return { kind: "thinking", label: "思考中…" };
  if (seg.kind === "tools") {
    const running = [...seg.calls].reverse().find((c) => c.status === "running");
    if (running) {
      const detail = summarizeArgs(running.name, running.args);
      return { kind: "tool", label: `正在${toolLabel(running.name)}`, detail: detail || undefined };
    }
    return { kind: "working", label: "正在工作…" };
  }
  if (seg.kind === "text") return { kind: "text", label: "正在输出…" };
  // 末段是已完成的思考：下一动作未到，按工作间隙处理
  return { kind: "working", label: "正在工作…" };
}

/** 耗时格式化：12s / 1:05 */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
