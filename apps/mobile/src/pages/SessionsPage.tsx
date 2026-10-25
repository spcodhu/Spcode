/**
 * 会话列表页：状态徽章 + 标题 + 入口；顶部「新任务」表单（聊天/项目模式）；
 * 列表项 ⋯ 菜单支持重命名 / 删除（二次确认）；底部 tab 进定时任务页；
 * 标题栏齿轮进设置（通知开关等）；长按标题区可解除配对。
 */

import type { SessionMeta, SessionMode } from "@spcode/shared";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsSheet } from "../components/SettingsSheet";
import { Sheet } from "../components/Sheet";
import { errorText, formatDate } from "../lib/i18n";
import { createSession, removeSession, renameSession, unpair } from "../state/controller";
import { type SessionStatus, useAppStore } from "../state/store";

const STATUS_CLASS: Record<SessionStatus, string> = {
  running: "bg-teal-950 text-teal-300",
  idle: "bg-slate-800 text-slate-400",
  waiting_permission: "bg-amber-950 text-amber-300",
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
    <Sheet
      title={t("sessions.newTask")}
      onClose={onClose}
      busy={busy}
      footer={
        <button
          type="button"
          disabled={busy || !prompt.trim() || (mode === "project" && !cwd.trim())}
          onClick={() => void submit()}
          className="min-h-12 w-full rounded-xl bg-teal-700 px-4 py-3 text-sm font-medium text-white transition-colors active:bg-teal-600 disabled:opacity-40"
        >
          {busy ? t("common.creating") : t("sessions.start")}
        </button>
      }
    >
      <div className="space-y-4">
        <fieldset className="flex gap-2" aria-label={t("sessions.newTask")}>
          {(["chat", "project"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={`min-h-11 flex-1 rounded-xl border px-3 py-2.5 text-sm transition-colors ${
                mode === m
                  ? "border-teal-600 bg-teal-800/70 text-teal-50"
                  : "border-slate-700 bg-slate-800/70 text-slate-300"
              }`}
            >
              {m === "chat" ? t("common.chat") : t("common.project")}
            </button>
          ))}
        </fieldset>
        {mode === "project" && (
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder={t("common.projectPath")}
            aria-label={t("common.projectPath")}
            autoCapitalize="off"
            spellCheck={false}
            className="min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-base text-slate-100 outline-none placeholder:text-slate-600 focus:border-teal-500"
          />
        )}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          placeholder={t("sessions.prompt")}
          aria-label={t("sessions.prompt")}
          className="min-h-28 w-full resize-y rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-base leading-6 text-slate-100 outline-none placeholder:text-slate-600 focus:border-teal-500"
        />
        {error != null && (
          <div role="alert" className="safe-break text-xs leading-5 text-red-300">
            {errorText(error)}
          </div>
        )}
      </div>
    </Sheet>
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

  const footer =
    mode === "rename" ? (
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => setMode("menu")}
          className="min-h-12 flex-1 rounded-xl bg-slate-800 px-3 py-3 text-sm text-slate-300 disabled:opacity-40"
        >
          {t("common.back")}
        </button>
        <button
          type="button"
          disabled={busy || !title.trim() || title.trim() === session.title}
          onClick={() => void run(() => renameSession(session.id, title.trim()))}
          className="min-h-12 flex-1 rounded-xl bg-teal-700 px-3 py-3 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? t("common.saving") : t("common.save")}
        </button>
      </div>
    ) : mode === "remove" ? (
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => setMode("menu")}
          className="min-h-12 flex-1 rounded-xl bg-slate-800 px-3 py-3 text-sm text-slate-300 disabled:opacity-40"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => removeSession(session.id))}
          className="min-h-12 flex-1 rounded-xl bg-red-800 px-3 py-3 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? t("common.deleting") : t("common.confirmDelete")}
        </button>
      </div>
    ) : undefined;

  return (
    <Sheet title={session.title} onClose={onClose} busy={busy} footer={footer}>
      {mode === "menu" && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setMode("rename")}
            className="min-h-12 w-full rounded-xl bg-slate-800 px-4 py-3 text-sm text-slate-100 transition-colors active:bg-slate-700"
          >
            {t("sessions.rename")}
          </button>
          <button
            type="button"
            onClick={() => setMode("remove")}
            className="min-h-12 w-full rounded-xl bg-red-950/70 px-4 py-3 text-sm text-red-300 transition-colors active:bg-red-950"
          >
            {t("sessions.delete")}
          </button>
        </div>
      )}

      {mode === "rename" && (
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={60}
          aria-label={t("sessions.rename")}
          data-dialog-initial-focus
          // biome-ignore lint/a11y/noAutofocus: 重命名弹层主动聚焦输入框，便于直接编辑
          autoFocus
          className="min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-base text-slate-100 outline-none focus:border-teal-500"
        />
      )}

      {mode === "remove" && (
        <div className="safe-break rounded-xl border border-red-900/70 bg-red-950/50 px-3 py-2.5 text-xs leading-5 text-red-200">
          {t("sessions.deleteWarning", { title: session.title })}
        </div>
      )}

      {error != null && (
        <div role="alert" className="safe-break mt-3 text-xs leading-5 text-red-300">
          {errorText(error)}
        </div>
      )}
    </Sheet>
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
      <header className="shrink-0 space-y-3 border-b border-slate-800/80 px-4 py-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight text-slate-100">
            {t("sessions.title")}
          </h1>
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            aria-label={t("common.settings")}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-800/80 text-base text-slate-300 transition-colors active:bg-slate-700"
          >
            <span aria-hidden="true">⚙</span>
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setRoute({ name: "schedules" })}
            className="min-h-11 rounded-xl bg-slate-800/80 px-3 py-2.5 text-xs font-medium text-slate-200 transition-colors active:bg-slate-700"
          >
            {t("schedules.title")}
          </button>
          <button
            type="button"
            onClick={() => setShowNew(true)}
            disabled={connState !== "ready"}
            className="min-h-11 rounded-xl bg-teal-700 px-3 py-2.5 text-xs font-medium text-white transition-colors active:bg-teal-600 disabled:opacity-40"
          >
            {t("sessions.addTask")}
          </button>
        </div>
      </header>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        {list.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm leading-7 text-slate-500">
            {t("sessions.empty")}
            <br />
            {t("sessions.emptyHint")}
          </div>
        ) : (
          list.map((s) => (
            <div key={s.id} className="flex items-stretch border-b border-slate-800/60">
              <button
                type="button"
                onClick={() => setRoute({ name: "session", id: s.id })}
                className="min-w-0 flex-1 px-4 py-3.5 text-left transition-colors active:bg-slate-800/40"
              >
                <span className="safe-break line-clamp-2 block text-sm font-medium leading-6 text-slate-100">
                  {s.title}
                </span>
                <span className="mt-1.5 flex min-w-0 items-center gap-2">
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] leading-4 ${STATUS_CLASS[s.status]}`}>
                    {t(`status.${s.status}`)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] leading-4 text-slate-500">
                    {s.mode === "project" ? s.cwd : t("common.chat")} · {formatDate(s.updatedAt)}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setActionsFor(s)}
                aria-label={t("sessions.actions", { title: s.title })}
                className="flex min-h-11 w-12 shrink-0 items-center justify-center self-stretch text-lg text-slate-500 transition-colors active:bg-slate-800/40 active:text-slate-200"
              >
                <span aria-hidden="true">⋯</span>
              </button>
            </div>
          ))
        )}
      </div>

      <footer className="shrink-0 border-t border-slate-800/80 px-4 py-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] text-center">
        {confirmUnpair ? (
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-red-300">
            <span>{t("sessions.confirmUnpair")}</span>
            <button type="button" className="min-h-11 px-2 underline" onClick={() => void unpair()}>
              {t("common.confirm")}
            </button>
            <button
              type="button"
              className="min-h-11 px-2 text-slate-400 underline"
              onClick={() => setConfirmUnpair(false)}
            >
              {t("common.cancel")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="min-h-11 px-2 text-[11px] text-slate-500"
            onClick={() => setConfirmUnpair(true)}
          >
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
