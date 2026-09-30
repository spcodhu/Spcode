/**
 * 定时任务调度器：~/.spcode/schedules.json 持久化，30 秒一次 tick。
 *
 * 到点判定（本地时间）：
 * - once：到达 runAt 且未跑过 → 触发后自动停用
 * - hourly：当前时刻已过本小时的 minute 且本小时未跑
 * - daily：已过今日 hour:minute 且今日未跑
 * - weekday：同 daily，但周六日不触发
 * - weekly：同 daily，但只在 weekday 指定日触发
 * 统一语义：每个周期最多触发一次；App 没运行错过的周期，下次启动补跑一次（不连补）。
 *
 * 触发动作由调用方注入（fire）：典型实现是新建会话并注入 prompt。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { type ScheduleTask, type ScheduleTaskInput } from "@spcode/shared";
import { resolveSpcodeHome } from "@spcode/shared/node";

const TICK_MS = 30_000;

export interface SchedulerOptions {
  /** 覆盖存储文件（测试用）；默认 ~/.spcode/schedules.json */
  file?: string;
  /** 触发动作：返回新建的会话 id；抛错记为 error 状态 */
  fire: (task: ScheduleTask) => Promise<string>;
  /** 触发后的通知（广播 schedule.fired / sessions.changed 给渲染进程） */
  notify?: (task: ScheduleTask, sessionId: string) => void;
  /** 时钟注入（测试用） */
  now?: () => number;
}

/** 纯函数：任务在当前时刻是否到点（导出供单测） */
export function isDue(task: ScheduleTask, nowMs: number): boolean {
  if (!task.enabled) return false;
  const last = task.lastRunAt ?? 0;
  const now = new Date(nowMs);

  if (task.frequency === "once") {
    return !!task.runAt && nowMs >= task.runAt && last < task.runAt;
  }
  if (task.frequency === "hourly") {
    const slot = new Date(now);
    slot.setMinutes(task.minute, 0, 0);
    slot.setMilliseconds(0);
    return nowMs >= slot.getTime() && last < slot.getTime();
  }
  // daily / weekday / weekly 共用"今日到点且今日未跑"
  if (task.frequency === "weekday") {
    const d = now.getDay();
    if (d === 0 || d === 6) return false;
  }
  if (task.frequency === "weekly" && now.getDay() !== (task.weekday ?? 1)) return false;
  const slot = new Date(now);
  slot.setHours(task.hour, task.minute, 0, 0);
  return nowMs >= slot.getTime() && last < slot.getTime();
}

/** 人性化周期描述（UI 展示用，导出供渲染层复用同类文案） */
export function describeSchedule(task: ScheduleTask): string {
  const hm = `${String(task.hour).padStart(2, "0")}:${String(task.minute).padStart(2, "0")}`;
  switch (task.frequency) {
    case "once":
      return task.runAt ? `单次 · ${new Date(task.runAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "单次";
    case "hourly":
      return `每小时 · 第 ${task.minute} 分`;
    case "daily":
      return `每天 ${hm}`;
    case "weekday":
      return `工作日 ${hm}`;
    case "weekly":
      return `每周${"日一二三四五六"[task.weekday ?? 1]} ${hm}`;
  }
}

export class Scheduler {
  private readonly file: string;
  private tasks: ScheduleTask[] | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(private readonly opts: SchedulerOptions) {
    const dir = resolveSpcodeHome();
    mkdirSync(dir, { recursive: true });
    this.file = opts.file ?? join(dir, "schedules.json");
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  list(): ScheduleTask[] {
    if (this.tasks) return this.tasks;
    if (!existsSync(this.file)) {
      this.tasks = [];
      return this.tasks;
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf-8")) as unknown;
      this.tasks = Array.isArray(raw) ? (raw as ScheduleTask[]) : [];
    } catch {
      this.tasks = [];
    }
    return this.tasks;
  }

  create(input: ScheduleTaskInput): ScheduleTask {
    const task: ScheduleTask = { ...input, id: randomUUID(), createdAt: this.opts.now?.() ?? Date.now() };
    const list = this.list();
    list.unshift(task);
    this.persist();
    return task;
  }

  update(id: string, patch: Partial<ScheduleTaskInput>): ScheduleTask | null {
    const list = this.list();
    const idx = list.findIndex((t) => t.id === id);
    const cur = idx >= 0 ? list[idx] : undefined;
    if (!cur) return null;
    // Partial 里 undefined = 未提供，剥掉后再合并（直接展开会把字段类型污染成 optional）
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = { ...cur, ...clean, id } as ScheduleTask;
    list[idx] = next;
    this.persist();
    return next;
  }

  remove(id: string): void {
    const list = this.list();
    const idx = list.findIndex((t) => t.id === id);
    if (idx >= 0) {
      list.splice(idx, 1);
      this.persist();
    }
  }

  // -------------------------------------------------------------------------
  // 调度
  // -------------------------------------------------------------------------

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 手动触发一次（试运行）：不影响到点判定，但记录运行状态 */
  async runNow(id: string): Promise<string> {
    const task = this.list().find((t) => t.id === id);
    if (!task) throw new Error(`任务不存在：${id}`);
    return this.fireOne(task);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const nowMs = this.opts.now?.() ?? Date.now();
      for (const task of this.list()) {
        if (!isDue(task, nowMs)) continue;
        // 先占位 lastRunAt：fire 失败也记，避免每 30 秒重试风暴
        this.markRun(task.id, nowMs);
        try {
          await this.fireOne(task);
          this.markStatus(task.id, "ok");
          if (task.frequency === "once") this.update(task.id, { enabled: false });
        } catch (err) {
          this.markStatus(task.id, "error", err instanceof Error ? err.message : String(err));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async fireOne(task: ScheduleTask): Promise<string> {
    const sessionId = await this.opts.fire(task);
    this.opts.notify?.(this.list().find((t) => t.id === task.id) ?? task, sessionId);
    return sessionId;
  }

  private markRun(id: string, at: number): void {
    const task = this.list().find((t) => t.id === id);
    if (!task) return;
    task.lastRunAt = at;
    this.persist();
  }

  private markStatus(id: string, status: "ok" | "error", error?: string): void {
    const task = this.list().find((t) => t.id === id);
    if (!task) return;
    task.lastStatus = status;
    task.lastError = error;
    this.persist();
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.tasks, null, 2), "utf-8");
    renameSync(tmp, this.file);
  }
}
