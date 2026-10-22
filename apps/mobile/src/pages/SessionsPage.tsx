/**
 * 会话列表页：状态徽章 + 标题 + 入口；顶部「新任务」表单（聊天/项目模式）；
 * 列表项 ⋯ 菜单支持重命名 / 删除（二次确认）；底部 tab 进定时任务页；
 * 标题栏齿轮进设置（通知开关等）；长按标题区可解除配对。
 */

import type { SessionMeta, SessionMode } from "@spcode/shared";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsSheet } from "../components/SettingsSheet";
import { errorText, formatDate } from "../lib/i18n";
import { createSession, removeSession, renameSession, unpair } from "../state/controller";
import { type SessionStatus, useAppStore } from "../state/store";

const STATUS_CLASS: Record<SessionStatus, string> = {
  running: "bg-emerald-900/70 text-emerald-300",
  idle: "bg-slate-800 text-slate-400",
  waiting_permission: "bg-amber-900/70 text-amber-300",
};

function NewTaskSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("mobile");
  const [mode, setMode] = useState<SessionMode>("chat");
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createSession({ mode, prompt: prompt.trim(), cwd: cwd.trim() || undefined });
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <div
        className="rounded-t-2xl border-t border-slate-700 bg-[#11161d] p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold text-slate-100">{t("sessions.newTask")}</div>
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
              {m === "chat" ? t("common.chat") : t("common.project")}
            </button>
          ))}
        </div>
        {mode === "project" && (
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder={t("common.projectPath")}
            className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
          />
        )}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          placeholder={t("sessions.prompt")}
          className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
        />
        {error != null && <div className="mt-2 text-xs text-red-400">{errorText(error)}</div>}
        <button
          type="button"
          disabled={busy || !prompt.trim() || (mode === "project" && !cwd.trim())}
          onClick={() => void submit()}
          className="mt-3 w-full rounded-xl bg-sky-600 py-3 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? t("common.creating") : t("sessions.start")}
        </button>
      </div>
    </div>
  );
}

/** 会话项 ⋯ 菜单：重命名（内联编辑）/ 删除（二次确认） */
function SessionActionsSheet({ session, onClose }: { session: SessionMeta; onClose: () => void }) {
  const { t } = useTranslation("mobile");
  const [mode, setMode] = useState<"menu" | "rename" | "remove">("menu");
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (err) {
      setError(err);
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
              {t("sessions.rename")}
            </button>
            <button
              type="button"
              onClick={() => setMode("remove")}
              className="w-full rounded-lg bg-red-950/70 py-2.5 text-sm text-red-300"
            >
              {t("sessions.delete")}
            </button>
          </div>
        )}

        {mode === "rename" && (
          <div className="mt-4">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={60}
              // biome-ignore lint/a11y/noAutofocus: 移动端重命名弹层聚焦输入框是预期交互（软键盘直接弹出）
              autoFocus
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
            />
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setMode("menu")}
                className="flex-1 rounded-lg bg-slate-800 py-2.5 text-sm text-slate-400"
              >
                {t("common.back")}
              </button>
              <button
                type="button"
                disabled={busy || !title.trim() || title.trim() === session.title}
                onClick={() => void run(() => renameSession(session.id, title.trim()))}
                className="flex-1 rounded-lg bg-sky-600 py-2.5 text-sm font-medium text-white disabled:opacity-40"
              >
                {busy ? t("common.saving") : t("common.save")}
              </button>
            </div>
          </div>
        )}

        {mode === "remove" && (
          <div className="mt-4">
            <div className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-xs leading-5 text-red-200">
              {t("sessions.deleteWarning", { title: session.title })}
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setMode("menu")}
                className="flex-1 rounded-lg bg-slate-800 py-2.5 text-sm text-slate-400"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => removeSession(session.id))}
                className="flex-1 rounded-lg bg-red-700 py-2.5 text-sm font-medium text-white disabled:opacity-40"
              >
                {busy ? t("common.deleting") : t("common.confirmDelete")}
              </button>
            </div>
          </div>
        )}

        {error != null && <div className="mt-3 text-xs text-red-400">{errorText(error)}</div>}
      </div>
    </div>
  );
}

export function SessionsPage() {
  const { t } = useTranslation("mobile");
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
          <div className="text-base font-bold text-slate-100">{t("sessions.title")}</div>
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            aria-label={t("common.settings")}
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
            {t("schedules.title")}
          </button>
          <button
            type="button"
            onClick={() => setShowNew(true)}
            disabled={connState !== "ready"}
            className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            {t("sessions.addTask")}
          </button>
        </div>
      </header>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        {list.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-slate-500">
            {t("sessions.empty")}
            <br />
            {t("sessions.emptyHint")}
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
                  {t(`status.${s.status}`)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-100">{s.title}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                    {s.mode === "project" ? s.cwd : t("common.chat")} · {formatDate(s.updatedAt)}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setActionsFor(s)}
                aria-label={t("sessions.actions", { title: s.title })}
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
            {t("sessions.confirmUnpair")}
            <button type="button" className="ml-2 underline" onClick={() => void unpair()}>
              {t("common.confirm")}
            </button>
            <button type="button" className="ml-2 text-slate-500 underline" onClick={() => setConfirmUnpair(false)}>
              {t("common.cancel")}
            </button>
          </span>
        ) : (
          <button type="button" className="text-[11px] text-slate-600" onClick={() => setConfirmUnpair(true)}>
            {t("sessions.footer")}
          </button>
        )}
      </footer>

      {showNew && <NewTaskSheet onClose={() => setShowNew(false)} />}
      {showSettings && <SettingsSheet onClose={() => setShowSettings(false)} />}
      {actionsFor && <SessionActionsSheet session={actionsFor} onClose={() => setActionsFor(null)} />}
    </div>
  );
}
