/**
 * 定时任务页：列表（启停 / 立即执行 / 编辑 / 删除）+ 创建与编辑表单（ScheduleEditorSheet）。
 */

import type { ScheduleTask } from "@spcode/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScheduleEditorSheet } from "../components/ScheduleEditor";
import { describeMobileSchedule, errorText, formatDate } from "../lib/i18n";
import { removeSchedule, runScheduleNow, toggleSchedule } from "../state/controller";
import { useAppStore } from "../state/store";

export function SchedulesPage() {
  const { t: tr } = useTranslation("mobile");
  const schedules = useAppStore((s) => s.schedules);
  const connState = useAppStore((s) => s.connState);
  const setRoute = useAppStore((s) => s.setRoute);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  /** undefined = 关闭；null = 新建；否则编辑该任务 */
  const [editing, setEditing] = useState<ScheduleTask | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);

  const run = async (fn: () => Promise<void>, id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-slate-800 px-3 py-3">
        <button
          type="button"
          aria-label={tr("common.back")}
          onClick={() => setRoute({ name: "sessions" })}
          className="px-1 text-lg text-slate-400"
        >
          ‹
        </button>
        <div className="flex-1 text-base font-bold text-slate-100">{tr("schedules.title")}</div>
        <button
          type="button"
          onClick={() => setEditing(null)}
          disabled={connState !== "ready"}
          className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          {tr("schedules.add")}
        </button>
      </header>

      {error != null && <div className="bg-red-950/50 px-4 py-1.5 text-xs text-red-300">{errorText(error)}</div>}

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        {schedules.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-slate-500">
            {tr("schedules.empty")}
            <br />
            {tr("schedules.emptyHint")}
          </div>
        ) : (
          schedules.map((t) => (
            <div key={t.id} className="border-b border-slate-800/60 px-4 py-3">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-slate-100">{t.name}</div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    {describeMobileSchedule(t)} ·{" "}
                    {t.target.kind === "project" ? t.target.cwd : tr("common.chatSession")}
                  </div>
                  {t.lastRunAt && (
                    <div className="mt-0.5 text-[11px] text-slate-600">
                      {tr("schedules.lastRun", { time: formatDate(t.lastRunAt) })}
                      {t.lastStatus === "error" && (
                        <span className="text-red-400">
                          {t.lastError == null
                            ? tr("schedules.failedUnknown")
                            : tr("schedules.failed", { error: t.lastError })}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  disabled={busyId === t.id || connState !== "ready"}
                  onClick={() => void run(() => toggleSchedule(t.id, !t.enabled), t.id)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                    t.enabled ? "bg-emerald-600" : "bg-slate-700"
                  } disabled:opacity-40`}
                  aria-label={t.enabled ? tr("schedules.disable") : tr("schedules.enable")}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${t.enabled ? "left-[22px]" : "left-0.5"}`}
                  />
                </button>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busyId === t.id || connState !== "ready"}
                  onClick={() => void run(() => runScheduleNow(t.id), t.id)}
                  className="rounded-lg bg-slate-800 px-3 py-1 text-xs text-sky-300 disabled:opacity-40"
                >
                  {tr("schedules.runNow")}
                </button>
                <button
                  type="button"
                  disabled={connState !== "ready"}
                  onClick={() => setEditing(t)}
                  className="rounded-lg bg-slate-800 px-3 py-1 text-xs text-slate-300 disabled:opacity-40"
                >
                  {tr("common.edit")}
                </button>
                {confirmRemoveId === t.id ? (
                  <>
                    <button
                      type="button"
                      disabled={busyId === t.id}
                      onClick={() => {
                        setConfirmRemoveId(null);
                        void run(() => removeSchedule(t.id), t.id);
                      }}
                      className="rounded-lg bg-red-900/70 px-3 py-1 text-xs text-red-200"
                    >
                      {tr("common.confirmDelete")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmRemoveId(null)}
                      className="rounded-lg bg-slate-800 px-3 py-1 text-xs text-slate-400"
                    >
                      {tr("common.cancel")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmRemoveId(t.id)}
                    className="rounded-lg bg-slate-800 px-3 py-1 text-xs text-slate-500"
                  >
                    {tr("common.delete")}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {editing !== undefined && <ScheduleEditorSheet task={editing} onClose={() => setEditing(undefined)} />}
    </div>
  );
}
