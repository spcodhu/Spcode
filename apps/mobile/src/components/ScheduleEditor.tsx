/**
 * 定时任务编辑器：创建 / 编辑共用的底部弹层表单。
 * 字段：名称、prompt（多行）、频率（单次/每小时/每天/工作日/每周 + 时间/星期）、
 * 模式（聊天/项目 + cwd）。提交走 schedule.create / schedule.update。
 */

import type { ScheduleFrequency, ScheduleTask, ScheduleTaskInput } from "@spcode/shared";
import { useState } from "react";
import { createSchedule, updateSchedule } from "../state/controller";

const FREQUENCY_TEXT: Record<ScheduleFrequency, string> = {
  once: "单次",
  hourly: "每小时",
  daily: "每天",
  weekday: "工作日（周一至五）",
  weekly: "每周",
};

const WEEKDAY_TEXT = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Date → datetime-local 输入框值（本地时区） */
function toLocalInputValue(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function ScheduleEditorSheet({
  task,
  onClose,
}: {
  /** null = 新建；否则编辑该任务 */
  task: ScheduleTask | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(task?.name ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [frequency, setFrequency] = useState<ScheduleFrequency>(task?.frequency ?? "daily");
  const [time, setTime] = useState(task ? `${pad2(task.hour)}:${pad2(task.minute)}` : "09:00");
  const [minute, setMinute] = useState(task?.minute ?? 0);
  const [weekday, setWeekday] = useState(task?.weekday ?? 1);
  const [runAtLocal, setRunAtLocal] = useState(() =>
    toLocalInputValue(task?.runAt && task.runAt > Date.now() ? task.runAt : Date.now() + 3600_000),
  );
  const [kind, setKind] = useState<"chat" | "project">(task?.target.kind ?? "chat");
  const [cwd, setCwd] = useState(task?.target.kind === "project" ? task.target.cwd : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildInput = (): ScheduleTaskInput | string => {
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName) return "请填写任务名称";
    if (!trimmedPrompt) return "请填写任务内容（prompt）";
    if (kind === "project" && !cwd.trim()) return "项目模式需要填写项目目录";

    const [h = 9, m = 0] = time.split(":").map((v) => Number(v));
    const base: ScheduleTaskInput = {
      name: trimmedName,
      prompt: trimmedPrompt,
      target: kind === "project" ? { kind: "project", cwd: cwd.trim() } : { kind: "chat" },
      frequency,
      hour: h,
      minute: frequency === "hourly" ? minute : m,
      enabled: task?.enabled ?? true,
    };
    if (frequency === "weekly") base.weekday = weekday;
    if (frequency === "once") {
      const runAt = new Date(runAtLocal).getTime();
      if (!Number.isFinite(runAt)) return "请选择单次任务的触发时间";
      base.runAt = runAt;
      // once 不用 hour/minute，但与触发时间对齐保持数据自洽
      const d = new Date(runAt);
      base.hour = d.getHours();
      base.minute = d.getMinutes();
    }
    return base;
  };

  const submit = async () => {
    if (busy) return;
    const input = buildInput();
    if (typeof input === "string") {
      setError(input);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (task) await updateSchedule(task.id, input);
      else await createSchedule(input);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <div
        className="thin-scroll max-h-[85%] overflow-y-auto rounded-t-2xl border-t border-slate-700 bg-[#11161d] p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold text-slate-100">{task ? "编辑定时任务" : "新建定时任务"}</div>

        <label className="mt-4 block text-xs text-slate-400">
          名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={50}
            placeholder="如：每日晨报"
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
          />
        </label>

        <label className="mt-3 block text-xs text-slate-400">
          任务内容（prompt）
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="触发时要执行的指令…"
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
          />
        </label>

        <label className="mt-3 block text-xs text-slate-400">
          频率
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as ScheduleFrequency)}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
          >
            {(Object.keys(FREQUENCY_TEXT) as ScheduleFrequency[]).map((f) => (
              <option key={f} value={f}>
                {FREQUENCY_TEXT[f]}
              </option>
            ))}
          </select>
        </label>

        {frequency === "once" && (
          <label className="mt-3 block text-xs text-slate-400">
            触发时间
            <input
              type="datetime-local"
              value={runAtLocal}
              onChange={(e) => setRunAtLocal(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
            />
          </label>
        )}

        {frequency === "hourly" && (
          <label className="mt-3 block text-xs text-slate-400">
            每小时的第几分
            <input
              type="number"
              min={0}
              max={59}
              value={minute}
              onChange={(e) => setMinute(Math.max(0, Math.min(59, Number(e.target.value) || 0)))}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
            />
          </label>
        )}

        {(frequency === "daily" || frequency === "weekday" || frequency === "weekly") && (
          <label className="mt-3 block text-xs text-slate-400">
            时间
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
            />
          </label>
        )}

        {frequency === "weekly" && (
          <label className="mt-3 block text-xs text-slate-400">
            星期
            <select
              value={weekday}
              onChange={(e) => setWeekday(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
            >
              {WEEKDAY_TEXT.map((w, i) => (
                <option key={w} value={i}>
                  {w}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="mt-3 text-xs text-slate-400">模式</div>
        <div className="mt-1 flex gap-2">
          {(["chat", "project"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`flex-1 rounded-lg py-2 text-sm ${
                kind === k ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-400"
              }`}
            >
              {k === "chat" ? "聊天会话" : "项目会话"}
            </button>
          ))}
        </div>
        {kind === "project" && (
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="项目目录（桌面端绝对路径，如 /Users/…/project）"
            className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
          />
        )}

        {error && <div className="mt-3 text-xs text-red-400">{error}</div>}
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="mt-4 w-full rounded-xl bg-sky-600 py-3 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? "保存中…" : task ? "保存" : "创建"}
        </button>
      </div>
    </div>
  );
}
