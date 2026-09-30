import type { ScheduleFrequency, ScheduleTarget, ScheduleTask, ScheduleTaskInput } from "@spcode/shared";
import { baseName, describeSchedule } from "@spcode/shared";
import { useEffect, useMemo, useState } from "react";
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
            定时任务
          </span>
          <div className="flex items-center gap-2">
            {editing === null && (
              <button
                type="button"
                onClick={() => setEditing("new")}
                className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-[12px] text-white hover:bg-accent-dim"
              >
                <Icon name="plus" size={13} />
                新建任务
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              title="关闭"
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
            <div className="py-10 text-center text-[13px] text-text-tertiary">读取中…</div>
          ) : tasks.length === 0 ? (
            <div className="py-10 text-center text-[13px] text-text-tertiary">
              还没有定时任务。建一个，比如「每天 09:00 生成今日晨报」。
            </div>
          ) : (
            <div className="space-y-2">
              {tasks.map((t) => (
                <div key={t.id} className="rounded-xl border border-border bg-bg-elevated px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Switch on={t.enabled} onChange={() => toggle(t)} label={`启用 ${t.name}`} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] text-text-primary">{t.name}</div>
                      <div className="mt-0.5 text-[12px] text-text-tertiary">
                        {describeSchedule(t)} ·{" "}
                        {t.target.kind === "project" ? `项目 ${baseName(t.target.cwd)}` : "新聊天会话"}
                        {t.lastStatus === "ok" && t.lastRunAt ? ` · 上次 ${formatRelative(t.lastRunAt)}` : ""}
                        {t.lastStatus === "error" ? ` · 上次失败：${t.lastError ?? "未知错误"}` : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => runNow(t)}
                      disabled={runningId === t.id}
                      title="立即运行一次"
                      className="rounded-lg px-2.5 py-1.5 text-[12px] text-accent hover:bg-bg-hover disabled:opacity-40"
                    >
                      {runningId === t.id ? "运行中…" : "立即运行"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(t)}
                      title="编辑"
                      className="rounded-lg p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
                    >
                      <Icon name="gear" size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => (confirmDelete === t.id ? remove(t.id) : setConfirmDelete(t.id))}
                      title="删除"
                      className={`rounded-lg p-1.5 text-[12px] ${
                        confirmDelete === t.id
                          ? "text-danger"
                          : "text-text-tertiary hover:bg-bg-hover hover:text-danger"
                      }`}
                    >
                      {confirmDelete === t.id ? "确认删除？" : <Icon name="x" size={14} />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-border px-5 py-2 text-[11px] text-text-tertiary">
          到点在后台新建会话并自动开跑；App 未运行时错过的任务，下次启动补跑一次。
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 新建 / 编辑表单
// ---------------------------------------------------------------------------

const FREQ_OPTIONS: { value: ScheduleFrequency; label: string }[] = [
  { value: "once", label: "单次" },
  { value: "hourly", label: "每小时" },
  { value: "daily", label: "每天" },
  { value: "weekday", label: "工作日（周一至周五）" },
  { value: "weekly", label: "每周" },
];

const WEEKDAY_OPTIONS = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: String(d), label: `周${"日一二三四五六"[d]}` }));

function TaskForm({
  task,
  onCancel,
  onSaved,
}: {
  task: ScheduleTask | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const registrySessions = useStore((s) => s.registrySessions);

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
      { value: "chat", label: "新聊天会话" },
      ...[...cwds.entries()].map(([cwd, base]) => ({ value: cwd, label: `项目：${base}` })),
    ];
  }, [registrySessions]);

  const hourOptions = useMemo(
    () => Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")} 时` })),
    [],
  );
  const minuteOptions = useMemo(
    () => Array.from({ length: 60 }, (_, m) => ({ value: String(m), label: `${String(m).padStart(2, "0")} 分` })),
    [],
  );

  const save = async () => {
    if (saving) return;
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName) return setError("给任务起个名字");
    if (!trimmedPrompt) return setError("填写触发时要执行的指令");

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
      if (!Number.isFinite(ts)) return setError("单次任务需要有效的触发时间");
      if (!task && ts <= Date.now()) return setError("触发时间已经过去，往后排一点");
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
          返回
        </button>
        <span className="text-[15px] font-semibold text-text-primary">{task ? "编辑任务" : "新建任务"}</span>
      </div>

      {error && <div className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}

      <Field label="任务名称">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：每日晨报"
          className="w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-[13px] outline-none focus:border-accent/50"
        />
      </Field>

      <Field label="触发时执行的指令">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="如：汇总我昨天的用量和配额情况，给出今日建议"
          rows={4}
          className="w-full resize-y rounded-lg border border-border bg-bg-elevated px-3 py-2 text-[13px] leading-5 outline-none focus:border-accent/50"
        />
      </Field>

      <Field label="执行目标">
        <Select value={targetKind} options={targetOptions} onChange={setTargetKind} />
      </Field>

      <Field label="频率">
        <Select value={frequency} options={FREQ_OPTIONS} onChange={(v) => setFrequency(v as ScheduleFrequency)} />
      </Field>

      {frequency === "once" && (
        <Field label="触发时间">
          <input
            type="datetime-local"
            value={runAt}
            onChange={(e) => setRunAt(e.target.value)}
            className="rounded-lg border border-border bg-bg-elevated px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent/50"
          />
        </Field>
      )}
      {frequency === "hourly" && (
        <Field label="每小时的第几分">
          <Select value={minute} options={minuteOptions} onChange={setMinute} className="w-36" />
        </Field>
      )}
      {(frequency === "daily" || frequency === "weekday" || frequency === "weekly") && (
        <Field label="触发时刻">
          <div className="flex items-center gap-2">
            {frequency === "weekly" && (
              <Select value={weekday} options={WEEKDAY_OPTIONS} onChange={setWeekday} className="w-28" />
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
          取消
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-lg bg-accent px-4 py-2 text-[13px] text-white hover:bg-accent-dim disabled:opacity-40"
        >
          {saving ? "保存中…" : task ? "保存修改" : "创建任务"}
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
