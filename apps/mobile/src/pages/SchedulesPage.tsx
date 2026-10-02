/**
 * 定时任务页（M1：只读列表 + 启停 + 立即执行；创建表单留到 M3）。
 */

import { describeSchedule } from "@spcode/shared";
import { useState } from "react";
import { removeSchedule, runScheduleNow, toggleSchedule } from "../state/controller";
import { useAppStore } from "../state/store";

export function SchedulesPage() {
  const schedules = useAppStore((s) => s.schedules);
  const connState = useAppStore((s) => s.connState);
  const setRoute = useAppStore((s) => s.setRoute);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>, id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-slate-800 px-3 py-3">
        <button type="button" onClick={() => setRoute({ name: "sessions" })} className="px-1 text-lg text-slate-400">
          ‹
        </button>
        <div className="flex-1 text-base font-bold text-slate-100">定时任务</div>
      </header>

      {error && <div className="bg-red-950/50 px-4 py-1.5 text-xs text-red-300">{error}</div>}

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        {schedules.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-slate-500">
            还没有定时任务。
            <br />
            请在桌面端创建（手机端创建表单后续版本提供）。
          </div>
        ) : (
          schedules.map((t) => (
            <div key={t.id} className="border-b border-slate-800/60 px-4 py-3">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-slate-100">{t.name}</div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    {describeSchedule(t)} · {t.target.kind === "project" ? t.target.cwd : "聊天会话"}
                  </div>
                  {t.lastRunAt && (
                    <div className="mt-0.5 text-[11px] text-slate-600">
                      上次运行{" "}
                      {new Date(t.lastRunAt).toLocaleString("zh-CN", {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      {t.lastStatus === "error" && (
                        <span className="text-red-400">（失败：{t.lastError ?? "未知"}）</span>
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
                  aria-label={t.enabled ? "停用" : "启用"}
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
                  立即执行
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
                      确认删除
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmRemoveId(null)}
                      className="rounded-lg bg-slate-800 px-3 py-1 text-xs text-slate-400"
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmRemoveId(t.id)}
                    className="rounded-lg bg-slate-800 px-3 py-1 text-xs text-slate-500"
                  >
                    删除
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
