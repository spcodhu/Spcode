/**
 * 定时任务页：列表（启停 / 立即执行 / 编辑 / 删除）+ 创建与编辑表单（ScheduleEditorSheet）。
 */

import type { ScheduleTask } from "@spcode/shared";
import { useRef, useState } from "react";
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
  const pendingRef = useRef(new Set<string>());
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  /** undefined = 关闭；null = 新建；否则编辑该任务 */
  const [editing, setEditing] = useState<ScheduleTask | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);

  const markPending = (id: string, pending: boolean) => {
    if (pending) pendingRef.current.add(id);
    else pendingRef.current.delete(id);
    setPendingIds(new Set(pendingRef.current));
  };
  const run = async (fn: () => Promise<void>, id: string) => {
    if (pendingRef.current.has(id)) return;
    markPending(id, true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      markPending(id, false);
    }
  };

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-slate-800/80 px-3 py-2.5">
        <button
          type="button"
          aria-label={tr("common.back")}
          onClick={() => setRoute({ name: "sessions" })}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl text-slate-400 active:bg-slate-800"
        >
          <span aria-hidden="true">‹</span>
        </button>
        <h1 className="min-w-0 flex-1 text-lg font-semibold text-slate-100">{tr("schedules.title")}</h1>
        <button
          type="button"
          onClick={() => setEditing(null)}
          disabled={connState !== "ready"}
          className="min-h-11 shrink-0 rounded-xl bg-teal-700 px-4 py-2.5 text-sm font-medium text-white active:bg-teal-600 disabled:opacity-40"
        >
          {tr("schedules.add")}
        </button>
      </header>

      {error != null && (
        <div role="alert" className="safe-break shrink-0 bg-red-950/50 px-4 py-2 text-xs leading-5 text-red-300">
          {errorText(error)}
        </div>
      )}

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        {schedules.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm leading-7 text-slate-400">
            {tr("schedules.empty")}
            <br />
            {tr("schedules.emptyHint")}
          </div>
        ) : (
          schedules.map((task) => {
            const pending = pendingIds.has(task.id);
            return (
              <section
                key={task.id}
                aria-busy={pending || undefined}
                className="border-b border-slate-800/60 px-4 py-4"
                data-testid={`schedule-row-${task.id}`}
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-sm font-medium text-slate-100">{task.name}</h2>
                    <div className="safe-break mt-1 text-xs leading-5 text-slate-400">
                      {describeMobileSchedule(task)} ·{" "}
                      {task.target.kind === "project" ? task.target.cwd : tr("common.chatSession")}
                    </div>
                    {task.lastRunAt && (
                      <div className="safe-break mt-1 text-[11px] leading-5 text-slate-500">
                        {tr("schedules.lastRun", { time: formatDate(task.lastRunAt) })}
                        {task.lastStatus === "error" && (
                          <span className="text-red-300">
                            {task.lastError == null
                              ? tr("schedules.failedUnknown")
                              : tr("schedules.failed", { error: task.lastError })}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={task.enabled}
                    disabled={pending || connState !== "ready"}
                    onClick={() => void run(() => toggleSchedule(task.id, !task.enabled), task.id)}
                    className="relative h-11 w-12 shrink-0 rounded-full disabled:opacity-40"
                    aria-label={task.enabled ? tr("schedules.disable") : tr("schedules.enable")}
                  >
                    <span
                      aria-hidden="true"
                      className={`absolute left-0.5 top-2.5 h-6 w-11 rounded-full transition-colors ${
                        task.enabled ? "bg-teal-600" : "bg-slate-700"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all ${
                          task.enabled ? "left-[22px]" : "left-0.5"
                        }`}
                      />
                    </span>
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid={`schedule-run-${task.id}`}
                    disabled={pending || connState !== "ready"}
                    onClick={() => void run(() => runScheduleNow(task.id), task.id)}
                    className="min-h-11 rounded-xl bg-slate-800 px-3.5 py-2.5 text-sm text-teal-200 active:bg-slate-700 disabled:opacity-40"
                  >
                    {pending ? tr("status.running") : tr("schedules.runNow")}
                  </button>
                  <button
                    type="button"
                    disabled={pending || connState !== "ready"}
                    onClick={() => setEditing(task)}
                    className="min-h-11 rounded-xl bg-slate-800 px-3.5 py-2.5 text-sm text-slate-200 active:bg-slate-700 disabled:opacity-40"
                  >
                    {tr("common.edit")}
                  </button>
                  {confirmRemoveId === task.id ? (
                    <>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => {
                          setConfirmRemoveId(null);
                          void run(() => removeSchedule(task.id), task.id);
                        }}
                        className="min-h-11 rounded-xl bg-red-950 px-3.5 py-2.5 text-sm text-red-200 disabled:opacity-40"
                      >
                        {tr("common.confirmDelete")}
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => setConfirmRemoveId(null)}
                        className="min-h-11 rounded-xl bg-slate-800 px-3.5 py-2.5 text-sm text-slate-300 disabled:opacity-40"
                      >
                        {tr("common.cancel")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={pending || connState !== "ready"}
                      onClick={() => setConfirmRemoveId(task.id)}
                      className="min-h-11 rounded-xl bg-slate-800 px-3.5 py-2.5 text-sm text-slate-400 active:bg-slate-700 disabled:opacity-40"
                    >
                      {tr("common.delete")}
                    </button>
                  )}
                </div>
              </section>
            );
          })
        )}
      </div>

      {editing !== undefined && <ScheduleEditorSheet task={editing} onClose={() => setEditing(undefined)} />}
    </div>
  );
}
