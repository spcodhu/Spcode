import type { ScheduleFrequency, ScheduleTarget, ScheduleTask, ScheduleTaskInput } from "@spcode/shared";
import { baseName, describeSchedule } from "@spcode/shared";
import { getLocale } from "@spcode/shared/i18n";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatRelative } from "../format";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { Select } from "./ui/Select";
import { Switch } from "./ui/Switch";

/**
 * 定时任务管理面板（侧栏时钟按钮）。
 * 到点触发 = 新建聊天/项目会话并注入 prompt；会话标题固定为任务名。
 */
export function SchedulePage({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("settings");
  const [tasks, setTasks] = useState<ScheduleTask[] | null>(null);
  const [editing, setEditing] = useState<ScheduleTask | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const reload = () => {
    void window.spcode
      .scheduleList()
      .then((t) => setTasks(t ?? []))
      .catch(() => setTasks([]));
  };
  useEffect(reload, []);

  const toggle = (t: ScheduleTask) => {
    void window.spcode.scheduleUpdate(t.id, { enabled: !t.enabled }).then(reload);
  };
  const remove = (id: string) => {
    void window.spcode.scheduleDelete(id).then(() => {
      setConfirmDelete(null);
      reload();
    });
  };
  const runNow = (t: ScheduleTask) => {
    setRunningId(t.id);
    void window.spcode
      .scheduleRunNow(t.id)
      .catch(() => {})
      .finally(() => {
        setRunningId(null);
        reload();
      });
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 遮罩点外关闭，Esc 另有键盘关闭（评审 R3：待统一 Modal 组件化时收敛）
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-[640px] max-h-[86vh] w-[720px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-border-strong bg-bg-main shadow-2xl">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <span className="flex items-center gap-2 text-[14px] font-semibold text-text-primary">
            <Icon name="clock" size={15} className="text-text-tertiary" />
            {t("schedule.title")}
          </span>
          <div className="flex items-center gap-2">
            {editing === null && (
              <button
                type="button"
                onClick={() => setEditing("new")}
                className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-[12px] text-on-accent hover:bg-accent-dim"
              >
                <Icon name="plus" size={13} />
                {t("schedule.new")}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              title={t("close")}
              className="rounded-lg p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {editing !== null ? (
            <TaskForm
              task={editing === "new" ? null : editing}
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                reload();
              }}
            />
          ) : tasks === null ? (
            <div className="py-10 text-center text-[13px] text-text-tertiary">{t("loading")}</div>
          ) : tasks.length === 0 ? (
            <div className="py-10 text-center text-[13px] text-text-tertiary">{t("schedule.empty")}</div>
          ) : (
            <div className="space-y-2">
              {tasks.map((item) => (
                <div key={item.id} className="rounded-xl border border-border bg-bg-elevated px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Switch
                      on={item.enabled}
                      onChange={() => toggle(item)}
                      label={t("enableName", { name: item.name })}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] text-text-primary">{item.name}</div>
                      <div className="mt-0.5 text-[12px] text-text-tertiary">
                        {describeSchedule(item)} ·{" "}
                        {item.target.kind === "project"
                          ? t("schedule.project", { name: baseName(item.target.cwd) })
                          : t("schedule.chat")}
                        {item.lastStatus === "ok" && item.lastRunAt
                          ? t("schedule.lastRun", { time: formatRelative(item.lastRunAt) })
                          : ""}
                        {item.lastStatus === "error"
                          ? t("schedule.lastError", { error: item.lastError ?? t("unknownError") })
                          : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => runNow(item)}
                      disabled={runningId === item.id}
                      title={t("schedule.runOnce")}
                      className="rounded-lg px-2.5 py-1.5 text-[12px] text-accent hover:bg-bg-hover disabled:opacity-40"
                    >
                      {runningId === item.id ? t("schedule.running") : t("schedule.run")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(item)}
                      title={t("schedule.edit")}
                      className="rounded-lg p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
                    >
                      <Icon name="gear" size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => (confirmDelete === item.id ? remove(item.id) : setConfirmDelete(item.id))}
                      title={t("schedule.delete")}
                      className={`rounded-lg p-1.5 text-[12px] ${
                        confirmDelete === item.id
                          ? "text-danger"
                          : "text-text-tertiary hover:bg-bg-hover hover:text-danger"
                      }`}
                    >
                      {confirmDelete === item.id ? t("schedule.confirmDelete") : <Icon name="x" size={14} />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-border px-5 py-2 text-[11px] text-text-tertiary">
          {t("schedule.footer")}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 新建 / 编辑表单
// ---------------------------------------------------------------------------

function TaskForm({
  task,
  onCancel,
  onSaved,
}: {
  task: ScheduleTask | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation("settings");
  const FREQ_OPTIONS: { value: ScheduleFrequency; label: string }[] = [
    { value: "once", label: t("schedule.once") },
    { value: "hourly", label: t("schedule.hourly") },
    { value: "daily", label: t("schedule.daily") },
    { value: "weekday", label: t("schedule.weekday") },
    { value: "weekly", label: t("schedule.weekly") },
  ];

  const registrySessions = useStore((s) => s.registrySessions);
  const weekdayOptions = [1, 2, 3, 4, 5, 6, 0].map((day) => ({
    value: String(day),
    label: new Intl.DateTimeFormat(getLocale(), { weekday: "short" }).format(new Date(2024, 0, 7 + day)),
  }));

  const [name, setName] = useState(task?.name ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [targetKind, setTargetKind] = useState<string>(task?.target.kind === "project" ? task.target.cwd : "chat");
  const [frequency, setFrequency] = useState<ScheduleFrequency>(task?.frequency ?? "daily");
  const [hour, setHour] = useState(String(task?.hour ?? 9));
  const [minute, setMinute] = useState(String(task?.minute ?? 0));
  const [weekday, setWeekday] = useState(String(task?.weekday ?? 1));
  const [runAt, setRunAt] = useState(() => {
    const ts = task?.runAt ?? Date.now() + 3600_000;
    // datetime-local 需要 YYYY-MM-DDTHH:MM 本地格式
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 目标候选：新聊天 + 已有项目空间的目录
  const targetOptions = useMemo(() => {
    const cwds = new Map<string, string>();
    for (const r of registrySessions) {
      if (r.mode === "project" && r.cwd) cwds.set(r.cwd, baseName(r.cwd));
    }
    return [
      { value: "chat", label: t("schedule.chat") },
      ...[...cwds.entries()].map(([cwd, base]) => ({ value: cwd, label: t("schedule.project", { name: base }) })),
    ];
  }, [registrySessions, t]);

  const hourOptions = useMemo(
    () =>
      Array.from({ length: 24 }, (_, h) => ({
        value: String(h),
        label: t("schedule.hourValue", {
          value: new Intl.NumberFormat(getLocale(), { minimumIntegerDigits: 2 }).format(h),
        }),
      })),
    [t],
  );
  const minuteOptions = useMemo(
    () =>
      Array.from({ length: 60 }, (_, m) => ({
        value: String(m),
        label: t("schedule.minuteValue", {
          value: new Intl.NumberFormat(getLocale(), { minimumIntegerDigits: 2 }).format(m),
        }),
      })),
    [t],
  );

  const save = async () => {
    if (saving) return;
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName) return setError(t("schedule.missingName"));
    if (!trimmedPrompt) return setError(t("schedule.missingPrompt"));

    const target: ScheduleTarget = targetKind === "chat" ? { kind: "chat" } : { kind: "project", cwd: targetKind };
    const input: ScheduleTaskInput = {
      name: trimmedName,
      prompt: trimmedPrompt,
      target,
      frequency,
      hour: Number(hour),
      minute: Number(minute),
      enabled: task?.enabled ?? true,
    };
    if (frequency === "weekly") input.weekday = Number(weekday);
    if (frequency === "once") {
      const ts = new Date(runAt).getTime();
      if (!Number.isFinite(ts)) return setError(t("schedule.invalidTime"));
      if (!task && ts <= Date.now()) return setError(t("schedule.pastTime"));
      input.runAt = ts;
    }

    setSaving(true);
    setError(null);
    try {
      if (task) await window.spcode.scheduleUpdate(task.id, input);
      else await window.spcode.scheduleCreate(input);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1 text-[13px] text-text-tertiary hover:text-text-primary"
        >
          <Icon name="chevronRight" size={13} style={{ transform: "rotate(180deg)" }} />
          {t("back")}
        </button>
        <span className="text-[15px] font-semibold text-text-primary">
          {task ? t("schedule.editTask") : t("schedule.new")}
        </span>
      </div>

      {error && <div className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}

      <Field label={t("schedule.name")}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("schedule.namePlaceholder")}
          className="w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-[13px] outline-none focus:border-accent/50"
        />
      </Field>

      <Field label={t("schedule.prompt")}>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("schedule.promptPlaceholder")}
          rows={4}
          className="w-full resize-y rounded-lg border border-border bg-bg-elevated px-3 py-2 text-[13px] leading-5 outline-none focus:border-accent/50"
        />
      </Field>

      <Field label={t("schedule.target")}>
        <Select value={targetKind} options={targetOptions} onChange={setTargetKind} />
      </Field>

      <Field label={t("schedule.frequency")}>
        <Select value={frequency} options={FREQ_OPTIONS} onChange={(v) => setFrequency(v as ScheduleFrequency)} />
      </Field>

      {frequency === "once" && (
        <Field label={t("schedule.runAt")}>
          <input
            type="datetime-local"
            value={runAt}
            onChange={(e) => setRunAt(e.target.value)}
            className="rounded-lg border border-border bg-bg-elevated px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent/50"
          />
        </Field>
      )}
      {frequency === "hourly" && (
        <Field label={t("schedule.minute")}>
          <Select value={minute} options={minuteOptions} onChange={setMinute} className="w-36" />
        </Field>
      )}
      {(frequency === "daily" || frequency === "weekday" || frequency === "weekly") && (
        <Field label={t("schedule.time")}>
          <div className="flex items-center gap-2">
            {frequency === "weekly" && (
              <Select value={weekday} options={weekdayOptions} onChange={setWeekday} className="w-28" />
            )}
            <Select value={hour} options={hourOptions} onChange={setHour} className="w-28" />
            <Select value={minute} options={minuteOptions} onChange={setMinute} className="w-28" />
          </div>
        </Field>
      )}

      <div className="mt-6 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-4 py-2 text-[13px] text-text-tertiary hover:bg-bg-hover"
        >
          {t("cancel")}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-lg bg-accent px-4 py-2 text-[13px] text-on-accent hover:bg-accent-dim disabled:opacity-40"
        >
          {saving ? t("saving") : task ? t("schedule.saveChanges") : t("schedule.create")}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 text-[12px] font-medium text-text-secondary">{label}</div>
      {children}
    </div>
  );
}
