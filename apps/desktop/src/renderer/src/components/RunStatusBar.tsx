/**
 * 运行状态条：常驻输入框正上方，回答「模型现在在干嘛」。
 *
 * 背景：运行头（"正在工作…"）与时间线工具行都在消息流里，多轮思考/调用后
 * 被滚出视口，用户在底部看不到模型状态。这里做一个不随消息流滚动的影子
 * 指示器；状态推导逻辑在 ../run-status（纯函数，便于单测）。
 */

import { useEffect, useState } from "react";
import { deriveRunStatus, formatElapsed, type RunStatus } from "../run-status";
import { useStore } from "../store";

const DOT_CLASS: Record<RunStatus["kind"], string> = {
  thinking: "bg-thinking",
  tool: "bg-warning",
  text: "bg-accent",
  working: "bg-accent",
  permission: "bg-warning",
  question: "bg-accent",
};

export function RunStatusBar({ sessionId, onJumpToBottom }: { sessionId: string; onJumpToBottom: () => void }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const pendingPermissions = useStore((s) => s.pendingPermissions);
  const pendingQuestions = useStore((s) => s.pendingQuestions);
  const status = deriveRunStatus(session, pendingPermissions, pendingQuestions, sessionId);
  const startedAt = session?.runStartedAt;

  const [now, setNow] = useState(() => Date.now());
  const active = !!status;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (!status) return null;
  const elapsed = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const shimmer = status.kind !== "permission" && status.kind !== "question";

  return (
    <div className="shrink-0 px-6 pb-1.5">
      <div className="mx-auto max-w-3xl">
        <button
          type="button"
          data-testid="run-status-bar"
          onClick={onJumpToBottom}
          title="点击跳到最新消息"
          className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-bg-hover/50"
        >
          <span
            aria-hidden
            className={`h-[7px] w-[7px] shrink-0 animate-pulse rounded-full ${DOT_CLASS[status.kind]}`}
          />
          <span className={`shrink-0 text-[12px] ${shimmer ? "thinking-shimmer" : "text-text-secondary"}`}>
            {status.label}
          </span>
          {status.detail && (
            <span className="mono min-w-0 flex-1 truncate text-[12px] text-text-tertiary" title={status.detail}>
              {status.detail}
            </span>
          )}
          {!status.detail && <span className="flex-1" />}
          {startedAt !== undefined && (
            <span className="shrink-0 text-[11px] tabular-nums text-text-tertiary">{formatElapsed(elapsed)}</span>
          )}
        </button>
      </div>
    </div>
  );
}
