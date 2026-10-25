/**
 * 会话详情页：输出流（text 正常渲染，thinking 折叠弱化）、todo 进度、
 * 底部输入框（运行中发送即 steer 插话）+ 中断按钮。
 */

import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorText, formatNumber } from "../lib/i18n";
import { abortSession, sendPrompt } from "../state/controller";
import { useAppStore } from "../state/store";

function OutputView({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("mobile");
  const chunks = useAppStore((s) => s.outputs[sessionId]);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [showThinking, setShowThinking] = useState(false);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [hasNewOutput, setHasNewOutput] = useState(false);

  const scrollToBottom = () => {
    stickRef.current = true;
    setAwayFromBottom(false);
    setHasNewOutput(false);
    const bottom = bottomRef.current;
    if (bottom && typeof bottom.scrollIntoView === "function") bottom.scrollIntoView({ block: "end" });
    else if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  };

  // 新输出到达时：停在底部则自动跟随；用户上滑后仅提示，不抢夺滚动位置。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只依赖 chunks；滚动函数与 ref 不需要重建此效果
  useEffect(() => {
    if (stickRef.current) scrollToBottom();
    else if (chunks && chunks.length > 0) setHasNewOutput(true);
  }, [chunks]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    stickRef.current = atBottom;
    setAwayFromBottom(!atBottom);
    if (atBottom) setHasNewOutput(false);
  };

  const hasThinking = chunks?.some((c) => c.kind === "thinking") ?? false;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        data-testid="session-output-scroller"
        className="thin-scroll h-full overflow-y-auto overscroll-contain px-4 py-4"
      >
        <div className="mx-auto max-w-prose">
          {!chunks || chunks.length === 0 ? (
            <div className="py-16 text-center text-sm text-slate-500">{t("session.emptyOutput")}</div>
          ) : (
            <div className="space-y-3">
              {chunks.map((c) => {
                if (c.gap) {
                  return (
                    <div key={c.id} className="py-1 text-center text-[11px] leading-5 text-slate-500">
                      {t("session.gap")}
                    </div>
                  );
                }
                if (c.kind === "thinking") {
                  return showThinking ? (
                    <pre
                      key={c.id}
                      className="safe-break whitespace-pre-wrap border-l-2 border-slate-700 py-1 pl-3 font-mono text-xs italic leading-6 text-slate-500"
                    >
                      {c.chunk}
                    </pre>
                  ) : null;
                }
                return (
                  <pre
                    key={c.id}
                    className="safe-break whitespace-pre-wrap rounded-2xl border border-slate-800/60 bg-slate-900/40 px-3.5 py-3 font-mono text-[13px] leading-6 text-slate-200"
                  >
                    {c.chunk}
                  </pre>
                );
              })}
            </div>
          )}
          {hasThinking && (
            <button
              type="button"
              onClick={() => setShowThinking((v) => !v)}
              className="mt-2 min-h-11 px-2 text-left text-xs text-slate-400 underline decoration-slate-700 underline-offset-4"
            >
              {showThinking ? t("session.hideThinking") : t("session.showThinking")}
            </button>
          )}
          <div ref={bottomRef} aria-hidden="true" />
        </div>
      </div>
      {awayFromBottom && (
        <button
          type="button"
          data-testid="output-scroll-bottom"
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 min-h-11 -translate-x-1/2 whitespace-nowrap rounded-full border border-teal-600/70 bg-[#142522]/95 px-4 py-2.5 text-xs font-medium text-teal-100 shadow-lg shadow-black/30"
        >
          {t(hasNewOutput ? "session.newOutput" : "session.backToBottom")} <span aria-hidden="true">↓</span>
        </button>
      )}
    </div>
  );
}

function TodoBar({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("mobile");
  const todos = useAppStore((s) => s.todos[sessionId]);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (!todos || todos.length === 0) return null;
  const done = todos.filter((todo) => todo.status === "completed").length;
  const active = todos.find((todo) => todo.status === "in_progress");
  return (
    <div className="shrink-0 border-t border-slate-800/80 bg-[#101716] px-4 py-1.5">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        data-testid="todo-toggle"
        onClick={() => setExpanded((value) => !value)}
        className="min-h-11 w-full py-1.5 text-left"
      >
        <span className="flex items-center gap-2 text-[11px] text-slate-400">
          <span className="shrink-0">
            {t("session.todos", { done: formatNumber(done), total: formatNumber(todos.length) })}
          </span>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800" aria-hidden="true">
            <span
              className="block h-full rounded-full bg-teal-500 transition-all"
              style={{ width: `${(done / todos.length) * 100}%` }}
            />
          </span>
          <span aria-hidden="true" className={`text-slate-500 transition-transform ${expanded ? "rotate-180" : ""}`}>
            ⌄
          </span>
        </span>
        {active && !expanded && (
          <span className="mt-0.5 block truncate text-[11px] leading-4 text-slate-500">
            ▸ {active.activeForm ?? active.content}
          </span>
        )}
      </button>
      {expanded && (
        <ol
          id={listId}
          data-testid="todo-list"
          className="thin-scroll mb-2 max-h-56 space-y-2.5 overflow-y-auto border-t border-slate-800/80 pt-2.5"
        >
          {todos.map((todo) => (
            <li key={`${todo.status}-${todo.content}`} className="flex items-start gap-2 text-xs leading-5">
              <span
                aria-hidden="true"
                className={`w-4 shrink-0 text-center ${
                  todo.status === "completed"
                    ? "text-teal-500"
                    : todo.status === "in_progress"
                      ? "text-amber-300"
                      : "text-slate-600"
                }`}
              >
                {todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "▸" : "○"}
              </span>
              <div className="safe-break min-w-0 flex-1">
                <div className={todo.status === "completed" ? "text-slate-500 line-through" : "text-slate-300"}>
                  {todo.content}
                </div>
                {todo.activeForm && todo.activeForm !== todo.content && (
                  <div className="mt-0.5 text-[11px] leading-4 text-slate-500">{todo.activeForm}</div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function SessionDetailPage({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("mobile");
  const session = useAppStore((s) => s.sessions[sessionId]);
  const connState = useAppStore((s) => s.connState);
  const setRoute = useAppStore((s) => s.setRoute);
  const [text, setText] = useState("");
  const [error, setError] = useState<unknown>(null);
  const running = session?.status === "running" || session?.status === "waiting_permission";

  const send = async () => {
    const t = text.trim();
    if (!t || connState !== "ready") return;
    setText("");
    setError(null);
    try {
      await sendPrompt(sessionId, t); // 运行中发送 = steer 插话（宿主侧无需特判）
    } catch (err) {
      setError(err);
      setText(t); // 失败回填
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-start gap-2 border-b border-slate-800/80 px-3 py-3">
        <button
          type="button"
          aria-label={t("common.back")}
          onClick={() => setRoute({ name: "sessions" })}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl text-slate-400 transition-colors active:bg-slate-800"
        >
          <span aria-hidden="true">‹</span>
        </button>
        <div className="min-w-0 flex-1 py-0.5">
          <div className="safe-break line-clamp-2 text-sm font-medium leading-6 text-slate-100">
            {session?.title ?? t("sessions.title")}
          </div>
          <div className="mt-0.5 flex items-start gap-2">
            <div className="safe-break min-w-0 flex-1 text-[11px] leading-4 text-slate-500">
              {session?.mode === "project" ? session.cwd : t("common.chatSession")}
            </div>
            {session && (
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] leading-4 ${
                  session.status === "running"
                    ? "bg-teal-950 text-teal-300"
                    : session.status === "waiting_permission"
                      ? "bg-amber-950 text-amber-300"
                      : "bg-slate-800 text-slate-400"
                }`}
              >
                {t(`status.${session.status}`)}
              </span>
            )}
          </div>
        </div>
      </header>

      <OutputView sessionId={sessionId} />
      <TodoBar sessionId={sessionId} />

      {error != null && (
        <div
          role="alert"
          className="safe-break shrink-0 border-t border-red-900/50 bg-red-950/40 px-4 py-2 text-xs leading-5 text-red-300"
        >
          {errorText(error)}
        </div>
      )}

      <div className="flex shrink-0 items-end gap-2 border-t border-slate-800/80 bg-[#101716] px-3 py-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={1}
          placeholder={running ? t("session.steerPlaceholder") : t("session.promptPlaceholder")}
          className="thin-scroll max-h-32 min-h-11 min-w-0 flex-1 resize-none overflow-y-auto rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-base leading-6 text-slate-100 outline-none placeholder:text-slate-600 focus:border-teal-500"
        />
        {running && (
          <button
            type="button"
            onClick={() => void abortSession(sessionId).catch((e) => setError(e))}
            disabled={connState !== "ready"}
            className="min-h-11 shrink-0 rounded-xl bg-red-950 px-3 py-2.5 text-xs text-red-200 disabled:opacity-40"
          >
            {t("session.abort")}
          </button>
        )}
        <button
          type="button"
          onClick={() => void send()}
          disabled={connState !== "ready" || !text.trim()}
          className="min-h-11 shrink-0 rounded-xl bg-teal-700 px-4 py-2.5 text-sm font-medium text-white transition-colors active:bg-teal-600 disabled:opacity-40"
        >
          {t("session.send")}
        </button>
      </div>
    </div>
  );
}
