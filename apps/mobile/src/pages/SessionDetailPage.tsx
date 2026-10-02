/**
 * 会话详情页：输出流（text 正常渲染，thinking 折叠弱化）、todo 进度、
 * 底部输入框（运行中发送即 steer 插话）+ 中断按钮。
 */

import { useEffect, useRef, useState } from "react";
import { abortSession, sendPrompt } from "../state/controller";
import { useAppStore } from "../state/store";

function OutputView({ sessionId }: { sessionId: string }) {
  const chunks = useAppStore((s) => s.outputs[sessionId]);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [showThinking, setShowThinking] = useState(false);

  // 新输出到达时：若用户本就停在底部则自动跟随
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只依赖 chunks；stickRef/bottomRef 为稳定 ref
  useEffect(() => {
    if (stickRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [chunks]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const hasThinking = chunks?.some((c) => c.kind === "thinking") ?? false;

  return (
    <div ref={scrollerRef} onScroll={onScroll} className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {!chunks || chunks.length === 0 ? (
        <div className="py-16 text-center text-sm text-slate-500">暂无输出</div>
      ) : (
        chunks.map((c) => {
          if (c.gap) {
            return (
              <div key={c.id} className="my-2 text-center text-[11px] text-slate-600">
                ··· 断线期间的输出未同步 ···
              </div>
            );
          }
          if (c.kind === "thinking") {
            return showThinking ? (
              <pre
                key={c.id}
                className="my-1 whitespace-pre-wrap break-words text-[13px] italic leading-6 text-slate-500"
              >
                {c.chunk}
              </pre>
            ) : null;
          }
          return (
            <pre key={c.id} className="my-1 whitespace-pre-wrap break-words text-[13px] leading-6 text-slate-200">
              {c.chunk}
            </pre>
          );
        })
      )}
      {hasThinking && (
        <button
          type="button"
          onClick={() => setShowThinking((v) => !v)}
          className="mt-1 text-[11px] text-slate-500 underline"
        >
          {showThinking ? "收起思考过程" : "展开思考过程"}
        </button>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

function TodoBar({ sessionId }: { sessionId: string }) {
  const todos = useAppStore((s) => s.todos[sessionId]);
  if (!todos || todos.length === 0) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  const active = todos.find((t) => t.status === "in_progress");
  return (
    <div className="border-t border-slate-800 bg-[#10151c] px-4 py-2">
      <div className="flex items-center gap-2 text-[11px] text-slate-400">
        <span className="shrink-0">
          待办 {done}/{todos.length}
        </span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${(done / todos.length) * 100}%` }}
          />
        </div>
      </div>
      {active && (
        <div className="mt-1 truncate text-[11px] text-slate-500">▸ {active.activeForm ?? active.content}</div>
      )}
    </div>
  );
}

export function SessionDetailPage({ sessionId }: { sessionId: string }) {
  const session = useAppStore((s) => s.sessions[sessionId]);
  const connState = useAppStore((s) => s.connState);
  const setRoute = useAppStore((s) => s.setRoute);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const running = session?.status === "running" || session?.status === "waiting_permission";

  const send = async () => {
    const t = text.trim();
    if (!t || connState !== "ready") return;
    setText("");
    setError(null);
    try {
      await sendPrompt(sessionId, t); // 运行中发送 = steer 插话（宿主侧无需特判）
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setText(t); // 失败回填
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-slate-800 px-3 py-3">
        <button type="button" onClick={() => setRoute({ name: "sessions" })} className="px-1 text-lg text-slate-400">
          ‹
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-slate-100">{session?.title ?? "会话"}</div>
          <div className="truncate text-[11px] text-slate-500">
            {session?.mode === "project" ? session.cwd : "聊天会话"}
          </div>
        </div>
        {session && (
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
              session.status === "running"
                ? "bg-emerald-900/70 text-emerald-300"
                : session.status === "waiting_permission"
                  ? "bg-amber-900/70 text-amber-300"
                  : "bg-slate-800 text-slate-400"
            }`}
          >
            {session.status === "running" ? "运行中" : session.status === "waiting_permission" ? "待批准" : "空闲"}
          </span>
        )}
      </header>

      <OutputView sessionId={sessionId} />
      <TodoBar sessionId={sessionId} />

      {error && (
        <div className="border-t border-red-900/50 bg-red-950/40 px-4 py-1.5 text-xs text-red-300">{error}</div>
      )}

      <div className="flex items-end gap-2 border-t border-slate-800 bg-[#10151c] px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={1}
          placeholder={running ? "插话（追加指令）…" : "输入指令…"}
          className="max-h-28 min-h-[38px] flex-1 resize-none rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
        />
        {running && (
          <button
            type="button"
            onClick={() => void abortSession(sessionId).catch((e) => setError(String(e)))}
            disabled={connState !== "ready"}
            className="h-[38px] shrink-0 rounded-xl bg-red-900/70 px-3 text-xs text-red-200 disabled:opacity-40"
          >
            中断
          </button>
        )}
        <button
          type="button"
          onClick={() => void send()}
          disabled={connState !== "ready" || !text.trim()}
          className="h-[38px] shrink-0 rounded-xl bg-sky-600 px-4 text-sm font-medium text-white disabled:opacity-40"
        >
          发送
        </button>
      </div>
    </div>
  );
}
