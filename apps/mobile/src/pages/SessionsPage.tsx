/**
 * 会话列表页：状态徽章 + 标题 + 入口；顶部「新任务」表单（聊天/项目模式）；
 * 列表项 ⋯ 菜单支持重命名 / 删除（二次确认）；底部 tab 进定时任务页；
 * 标题栏齿轮进设置（通知开关等）；长按标题区可解除配对。
 */

import type { ModelRef, SessionMeta, SessionMode } from "@spcode/shared";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { ModelField } from "../components/ModelPickerSheet";
import { collectProjectOptions, ProjectPicker } from "../components/ProjectPicker";
import { SettingsSheet } from "../components/SettingsSheet";
import { Sheet } from "../components/Sheet";
import { errorText, formatDate } from "../lib/i18n";
import { createSession, removeSession, renameSession, unpair } from "../state/controller";
import { type SessionStatus, useAppStore } from "../state/store";

const STATUS_CLASS: Record<SessionStatus, string> = {
  running: "bg-accent-soft text-accent",
  idle: "bg-bg-elevated text-text-tertiary",
  waiting_permission: "bg-amber-950 text-amber-300",
};

function NewTaskSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("mobile");
  const sessions = useAppStore((s) => s.sessions);
  const projects = useMemo(() => collectProjectOptions(Object.values(sessions)), [sessions]);
  const [mode, setMode] = useState<SessionMode>("chat");
  const [model, setModel] = useState<ModelRef | null>(null);
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (mode !== "project") return;
    if (!cwd || !projects.some((project) => project.cwd === cwd)) setCwd(projects[0]?.cwd ?? "");
  }, [mode, projects, cwd]);

  const submit = async () => {
    if (busy || (mode === "project" && !cwd)) return;
    setBusy(true);
    setError(null);
    try {
      // 先进入空会话，首条指令在详情页输入；不再把 prompt 当作创建前置条件。
      await createSession({
        mode,
        cwd: mode === "project" ? cwd : undefined,
        ...(model ? { model } : {}),
      });
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={t("sessions.newTask")}
      description={t("sessions.createHint")}
      onClose={onClose}
      busy={busy}
      footer={
        <button
          type="button"
          data-testid="new-session-submit"
          disabled={busy || (mode === "project" && !cwd)}
          onClick={() => void submit()}
          className="min-h-12 w-full rounded-xl bg-accent px-4 py-3 text-sm font-medium text-on-accent transition-colors active:bg-accent-dim disabled:opacity-40"
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
              data-testid={`new-session-mode-${m}`}
              onClick={() => setMode(m)}
              className={`min-h-11 flex-1 rounded-xl border px-3 py-2.5 text-sm transition-colors ${
                mode === m
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border-strong bg-bg-elevated text-text-secondary"
              }`}
            >
              {m === "chat" ? t("common.chat") : t("common.project")}
            </button>
          ))}
        </fieldset>
        <div>
          <div className="mb-1.5 text-xs font-medium text-text-tertiary">{t("models.label")}</div>
          <ModelField value={model} onChange={setModel} />
        </div>
        {mode === "project" ? (
          <ProjectPicker projects={projects} value={cwd} onChange={setCwd} />
        ) : (
          <div className="rounded-xl border border-border bg-bg-elevated px-3.5 py-3 text-xs leading-5 text-text-tertiary">
            {t("sessions.chatHint")}
          </div>
        )}
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
          className="min-h-12 flex-1 rounded-xl bg-bg-elevated px-3 py-3 text-sm text-text-secondary disabled:opacity-40"
        >
          {t("common.back")}
        </button>
        <button
          type="button"
          disabled={busy || !title.trim() || title.trim() === session.title}
          onClick={() => void run(() => renameSession(session.id, title.trim()))}
          className="min-h-12 flex-1 rounded-xl bg-accent px-3 py-3 text-sm font-medium text-on-accent disabled:opacity-40"
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
          className="min-h-12 flex-1 rounded-xl bg-bg-elevated px-3 py-3 text-sm text-text-secondary disabled:opacity-40"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => removeSession(session.id))}
          className="min-h-12 flex-1 rounded-xl bg-red-800 px-3 py-3 text-sm font-medium text-on-accent disabled:opacity-40"
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
            className="min-h-12 w-full rounded-xl bg-bg-elevated px-4 py-3 text-sm text-text-primary transition-colors active:bg-bg-active"
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
          className="min-h-11 w-full rounded-xl border border-border-strong bg-bg-main/70 px-3 py-2.5 text-base text-text-primary outline-none focus:border-accent"
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
      <header className="shrink-0 space-y-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight text-text-primary">
            {t("sessions.title")}
          </h1>
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            aria-label={t("common.settings")}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-bg-elevated text-base text-text-secondary transition-colors active:bg-bg-active"
          >
            <Icon name="settings" size={20} testId="settings-icon" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setRoute({ name: "schedules" })}
            className="min-h-11 rounded-xl bg-bg-elevated px-3 py-2.5 text-xs font-medium text-text-primary transition-colors active:bg-bg-active"
          >
            {t("schedules.title")}
          </button>
          <button
            type="button"
            onClick={() => setShowNew(true)}
            disabled={connState !== "ready"}
            className="min-h-11 rounded-xl bg-accent px-3 py-2.5 text-xs font-medium text-on-accent transition-colors active:bg-accent-dim disabled:opacity-40"
          >
            {t("sessions.addTask")}
          </button>
        </div>
      </header>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        {list.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm leading-7 text-text-tertiary">
            {t("sessions.empty")}
            <br />
            {t("sessions.emptyHint")}
          </div>
        ) : (
          list.map((s) => (
            <div key={s.id} className="flex items-stretch border-b border-border">
              <button
                type="button"
                onClick={() => setRoute({ name: "session", id: s.id })}
                className="min-w-0 flex-1 px-4 py-3.5 text-left transition-colors active:bg-bg-hover"
              >
                <span className="safe-break line-clamp-2 block text-sm font-medium leading-6 text-text-primary">
                  {s.title}
                </span>
                <span className="mt-1.5 flex min-w-0 items-center gap-2">
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] leading-4 ${STATUS_CLASS[s.status]}`}>
                    {t(`status.${s.status}`)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] leading-4 text-text-tertiary">
                    {s.mode === "project" ? s.cwd : t("common.chat")} · {formatDate(s.updatedAt)}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setActionsFor(s)}
                aria-label={t("sessions.actions", { title: s.title })}
                className="flex min-h-11 w-12 shrink-0 items-center justify-center self-stretch text-lg text-text-tertiary transition-colors active:bg-bg-hover active:text-text-primary"
              >
                <span aria-hidden="true">⋯</span>
              </button>
            </div>
          ))
        )}
      </div>

      <footer className="shrink-0 border-t border-border px-4 py-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] text-center">
        {confirmUnpair ? (
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-red-300">
            <span>{t("sessions.confirmUnpair")}</span>
            <button type="button" className="min-h-11 px-2 underline" onClick={() => void unpair()}>
              {t("common.confirm")}
            </button>
            <button
              type="button"
              className="min-h-11 px-2 text-text-tertiary underline"
              onClick={() => setConfirmUnpair(false)}
            >
              {t("common.cancel")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="min-h-11 px-2 text-[11px] text-text-tertiary"
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
