/**
 * 定时任务编辑器：创建 / 编辑共用的底部弹层表单。
 * 字段：名称、prompt（多行）、频率（单次/每小时/每天/工作日/每周 + 时间/星期）、
 * 模式（聊天/项目 + cwd）。提交走 schedule.create / schedule.update。
 */

import type { ScheduleFrequency, ScheduleTask, ScheduleTaskInput } from "@spcode/shared";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorText, formatWeekday, MobileError } from "../lib/i18n";
import { createSchedule, updateSchedule } from "../state/controller";
import { Sheet } from "./Sheet";

const FREQUENCIES = ["once", "hourly", "daily", "weekday", "weekly"] as const;
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const FIELD_CLASS =
  "mt-1.5 min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-base text-slate-100 outline-none placeholder:text-slate-600 focus:border-teal-500";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Date → datetime-local 输入框值（本地时区） */
function toLocalInputValue(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function parseTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function ScheduleEditorSheet({
  task,
  onClose,
}: {
  /** null = 新建；否则编辑该任务 */
  task: ScheduleTask | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("mobile");
  const [name, setName] = useState(task?.name ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [frequency, setFrequency] = useState<ScheduleFrequency>(task?.frequency ?? "daily");
  const [time, setTime] = useState(task ? `${pad2(task.hour)}:${pad2(task.minute)}` : "09:00");
  const [minute, setMinute] = useState(task?.minute ?? 0);
  const [weekday, setWeekday] = useState(task?.weekday ?? 1);
  const [initialRunAtLocal] = useState(() => toLocalInputValue(task?.runAt ?? Date.now() + 3600_000));
  const [runAtLocal, setRunAtLocal] = useState(initialRunAtLocal);
  const [kind, setKind] = useState<"chat" | "project">(task?.target.kind ?? "chat");
  const [cwd, setCwd] = useState(task?.target.kind === "project" ? task.target.cwd : "");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const submissionGeneration = useRef(0);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      submissionGeneration.current += 1;
    };
  }, []);

  const buildInput = (): ScheduleTaskInput | Error => {
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName) return new MobileError("schedule.nameRequired");
    if (!trimmedPrompt) return new MobileError("schedule.promptRequired");
    if (kind === "project" && !cwd.trim()) return new MobileError("schedule.cwdRequired");

    let hour = task?.hour ?? 9;
    let scheduledMinute = frequency === "hourly" ? minute : (task?.minute ?? 0);
    if (frequency === "daily" || frequency === "weekday" || frequency === "weekly") {
      const parsed = parseTime(time);
      if (!parsed) return new Error(t("schedule.timeInvalid"));
      hour = parsed.hour;
      scheduledMinute = parsed.minute;
    }

    const base: ScheduleTaskInput = {
      name: trimmedName,
      prompt: trimmedPrompt,
      target: kind === "project" ? { kind: "project", cwd: cwd.trim() } : { kind: "chat" },
      frequency,
      hour,
      minute: scheduledMinute,
      enabled: task?.enabled ?? true,
    };
    if (frequency === "weekly") base.weekday = weekday;
    if (frequency === "once") {
      // datetime-local 只有分钟精度；未修改时保留原时间戳，避免仅改名就丢失秒/毫秒或刷新过期时间。
      const keepOriginal = task?.frequency === "once" && task.runAt != null && runAtLocal === initialRunAtLocal;
      const runAt = keepOriginal ? task.runAt! : new Date(runAtLocal).getTime();
      if (!runAtLocal.trim() || !Number.isFinite(runAt)) return new MobileError("schedule.runAtRequired");
      base.runAt = runAt;
      // once 不用 hour/minute，但与触发时间对齐保持数据自洽
      const d = new Date(runAt);
      base.hour = d.getHours();
      base.minute = d.getMinutes();
    }
    return base;
  };

  const submit = async () => {
    if (busyRef.current) return;
    const input = buildInput();
    if (input instanceof Error) {
      setError(input);
      return;
    }
    const generation = ++submissionGeneration.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (task) await updateSchedule(task.id, input);
      else await createSchedule(input);
      // 旧表单的异步结果不得关闭后来打开的新表单，也不得在卸载后更新 state。
      if (!mountedRef.current || generation !== submissionGeneration.current) return;
      onClose();
    } catch (err) {
      if (!mountedRef.current || generation !== submissionGeneration.current) return;
      setError(err);
      busyRef.current = false;
      setBusy(false);
    }
  };

  const requestClose = () => {
    if (busyRef.current) return;
    submissionGeneration.current += 1;
    onClose();
  };

  return (
    <Sheet
      title={task ? t("schedule.edit") : t("schedule.create")}
      onClose={requestClose}
      busy={busy}
      footer={
        <button
          type="button"
          data-testid="schedule-submit"
          disabled={busy}
          onClick={() => void submit()}
          className="min-h-12 w-full rounded-xl bg-teal-700 px-4 py-3 text-sm font-medium text-white transition-colors active:bg-teal-600 disabled:opacity-40"
        >
          {busy ? t("common.saving") : task ? t("common.save") : t("common.create")}
        </button>
      }
    >
      <div className="space-y-4">
        <label className="block text-xs font-medium text-slate-400">
          {t("schedule.name")}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={50}
            placeholder={t("schedule.namePlaceholder")}
            className={FIELD_CLASS}
          />
        </label>

        <label className="block text-xs font-medium text-slate-400">
          {t("schedule.prompt")}
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder={t("schedule.promptPlaceholder")}
            className={`${FIELD_CLASS} min-h-28 resize-y leading-6`}
          />
        </label>

        <label className="block text-xs font-medium text-slate-400">
          {t("schedule.frequency")}
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as ScheduleFrequency)}
            className={FIELD_CLASS}
          >
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {t(`schedule.${f}`)}
              </option>
            ))}
          </select>
        </label>

        {frequency === "once" && (
          <label className="block text-xs font-medium text-slate-400">
            {t("schedule.runAt")}
            <input
              type="datetime-local"
              value={runAtLocal}
              onChange={(e) => setRunAtLocal(e.target.value)}
              className={FIELD_CLASS}
            />
          </label>
        )}

        {frequency === "hourly" && (
          <label className="block text-xs font-medium text-slate-400">
            {t("schedule.minute")}
            <input
              type="number"
              min={0}
              max={59}
              value={minute}
              onChange={(e) => setMinute(Math.max(0, Math.min(59, Number(e.target.value) || 0)))}
              className={FIELD_CLASS}
            />
          </label>
        )}

        {(frequency === "daily" || frequency === "weekday" || frequency === "weekly") && (
          <label className="block text-xs font-medium text-slate-400">
            {t("schedule.time")}
            <input
              type="time"
              value={time}
              required
              onChange={(e) => setTime(e.target.value)}
              className={FIELD_CLASS}
            />
          </label>
        )}

        {frequency === "weekly" && (
          <label className="block text-xs font-medium text-slate-400">
            {t("schedule.dayOfWeek")}
            <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} className={FIELD_CLASS}>
              {WEEKDAYS.map((day) => (
                <option key={day} value={day}>
                  {formatWeekday(day)}
                </option>
              ))}
            </select>
          </label>
        )}

        <div>
          <div className="text-xs font-medium text-slate-400">{t("schedule.mode")}</div>
          <fieldset className="mt-1.5 flex gap-2" aria-label={t("schedule.mode")}>
            {(["chat", "project"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={`min-h-11 flex-1 rounded-xl border px-3 py-2.5 text-sm transition-colors ${
                  kind === k
                    ? "border-teal-600 bg-teal-800/70 text-teal-50"
                    : "border-slate-700 bg-slate-800/70 text-slate-300"
                }`}
              >
                {k === "chat" ? t("common.chatSession") : t("common.projectSession")}
              </button>
            ))}
          </fieldset>
          {kind === "project" && (
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder={t("common.projectPath")}
              aria-label={t("common.projectPath")}
              autoCapitalize="off"
              spellCheck={false}
              className={FIELD_CLASS}
            />
          )}
        </div>

        {error != null && (
          <div role="alert" className="safe-break text-xs leading-5 text-red-300">
            {errorText(error)}
          </div>
        )}
      </div>
    </Sheet>
  );
}
