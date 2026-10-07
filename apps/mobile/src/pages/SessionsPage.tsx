/**
 * 会话列表页：状态徽章 + 标题 + 入口；顶部「新任务」表单（聊天/项目模式）；
 * 列表项 ⋯ 菜单支持重命名 / 删除（二次确认）；底部 tab 进定时任务页；
 * 标题栏齿轮进设置（通知开关等）；长按标题区可解除配对。
 */

import type { SessionMode, SessionMeta } from "@spcode/shared";
import { useMemo, useState } from "react";
import { SettingsSheet } from "../components/SettingsSheet";
import { createSession, removeSession, renameSession, unpair } from "../state/controller";
import { type SessionStatus, useAppStore } from "../state/store";

const STATUS_TEXT: Record<SessionStatus, string> = {
  running: "运行中",
  idle: "空闲",
  waiting_permission: "待批准",
};

const STATUS_CLASS: Record<SessionStatus, string> = {
  running: "bg-emerald-900/70 text-emerald-300",
  idle: "bg-slate-800 text-slate-400",
  waiting_permission: "bg-amber-900/70 text-amber-300",
};

function NewTaskSheet({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<SessionMode>("chat");
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createSession({ mode, prompt: prompt.trim(), cwd: cwd.trim() || undefined });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <div
        className="rounded-t-2xl border-t border-slate-700 bg-[#11161d] p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold text-slate-100">新任务</div>
        <div className="mt-3 flex gap-2">
          {(["chat", "project"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex-1 rounded-lg py-2 text-sm ${
                mode === m ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-400"
              }`}
            >
              {m === "chat" ? "聊天" : "项目"}
            </button>
          ))}
        </div>
        {mode === "project" && (
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="项目目录（桌面端绝对路径，如 /Users/…/project）"
            className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
          />
        )}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          placeholder="要做什么？（首条指令）"
          className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
        />
        {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
        <button
          type="button"
          disabled={busy || !prompt.trim() || (mode === "project" && !cwd.trim())}
          onClick={() => void submit()}
          className="mt-3 w-full rounded-xl bg-sky-600 py-3 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? "创建中…" : "开始"}
        </button>
      </div>
    </div>
  );
}

/** 会话项 ⋯ 菜单：重命名（内联编辑）/ 删除（二次确认） */
function SessionActionsSheet({ session, onClose }: { session: SessionMeta; onClose: () => void }) {
  const [mode, setMode] = useState<"menu" | "rename" | "remove">("menu");
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <div
        className="rounded-t-2xl border-t border-slate-700 bg-[#11161d] p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="truncate text-base font-semibold text-slate-100">{session.title}</div>

        {mode === "menu" && (
          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setMode("rename")}
              className="w-full rounded-lg bg-slate-800 py-2.5 text-sm text-slate-200"
            >
              重命名
            </button>
            <button
              type="button"
              onClick={() => setMode("remove")}
              className="w-full rounded-lg bg-red-950/70 py-2.5 text-sm text-red-300"
            >
              删除会话
            </button>
          </div>
        )}

        {mode === "rename" && (
          <div className="mt-4">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={60}
              autoFocus
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
            />
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setMode("menu")}
                className="flex-1 rounded-lg bg-slate-800 py-2.5 text-sm text-slate-400"
              >
                返回
              </button>
              <button
                type="button"
                disabled={busy || !title.trim() || title.trim() === session.title}
                onClick={() => void run(() => renameSession(session.id, title.trim()))}
                className="flex-1 rounded-lg bg-sky-600 py-2.5 text-sm font-medium text-white disabled:opacity-40"
              >
                {busy ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        )}

        {mode === "remove" && (
          <div className="mt-4">
            <div className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-xs leading-5 text-red-200">
              删除后桌面端的会话记录与输出一并清除，不可恢复。确定删除「{session.title}」？
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setMode("menu")}
                className="flex-1 rounded-lg bg-slate-800 py-2.5 text-sm text-slate-400"
              >
                取消
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => removeSession(session.id))}
                className="flex-1 rounded-lg bg-red-700 py-2.5 text-sm font-medium text-white disabled:opacity-40"
              >
                {busy ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        )}

        {error && <div className="mt-3 text-xs text-red-400">{error}</div>}
      </div>
    </div>
  );
}

export function SessionsPage() {
  const sessions = useAppStore((s) => s.sessions);
  const connState = useAppStore((s) => s.connState);
  const setRoute = useAppStore((s) => s.setRoute);
  const [showNew, setShowNew] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [actionsFor, setActionsFor] = useState<SessionMeta | null>(null);
  const [confirmUnpair, setConfirmUnpair] = useState(false);

  const list = useMemo(() => Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt), [sessions]);

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="text-base font-bold text-slate-100">会话</div>
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            aria-label="设置"
            className="rounded-lg bg-slate-800 px-2 py-1 text-xs text-slate-400"
          >
            ⚙
          </button>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setRoute({ name: "schedules" })}
            className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300"
          >
            定时任务
          </button>
          <button
            type="button"
            onClick={() => setShowNew(true)}
            disabled={connState !== "ready"}
            className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            + 新任务
          </button>
        </div>
      </header>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        {list.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-slate-500">
            还没有会话。
            <br />
            点右上角「+ 新任务」开始。
          </div>
        ) : (
          list.map((s) => (
            <div key={s.id} className="flex items-center border-b border-slate-800/60">
              <button
                type="button"
                onClick={() => setRoute({ name: "session", id: s.id })}
                className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left active:bg-slate-800/40"
              >
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${STATUS_CLASS[s.status]}`}>
                  {STATUS_TEXT[s.status]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-100">{s.title}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                    {s.mode === "project" ? s.cwd : "聊天"} ·{" "}
                    {new Date(s.updatedAt).toLocaleString("zh-CN", {
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setActionsFor(s)}
                aria-label={`会话操作：${s.title}`}
                className="shrink-0 px-3 py-3 text-slate-500 active:text-slate-300"
              >
                ⋯
              </button>
            </div>
          ))
        )}
      </div>

      <footer className="border-t border-slate-800 px-4 py-2 text-center">
        {confirmUnpair ? (
          <span className="text-xs text-red-400">
            确定解除配对？
            <button type="button" className="ml-2 underline" onClick={() => void unpair()}>
              确定
            </button>
            <button type="button" className="ml-2 text-slate-500 underline" onClick={() => setConfirmUnpair(false)}>
              取消
            </button>
          </span>
        ) : (
          <button type="button" className="text-[11px] text-slate-600" onClick={() => setConfirmUnpair(true)}>
            Spcod 远程控制 · 端到端加密 · 解除配对
          </button>
        )}
      </footer>

      {showNew && <NewTaskSheet onClose={() => setShowNew(false)} />}
      {showSettings && <SettingsSheet onClose={() => setShowSettings(false)} />}
      {actionsFor && <SessionActionsSheet session={actionsFor} onClose={() => setActionsFor(null)} />}
    </div>
  );
}
