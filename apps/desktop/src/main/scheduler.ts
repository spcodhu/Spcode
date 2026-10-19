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

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ScheduleTask, ScheduleTaskInput } from "@spcode/shared";
import { readJsonFile, resolveSpcodeHome, writeJsonFileAtomic } from "@spcode/shared/node";

/** 任务条目的最低结构要求：关键字段类型正确 + 值域合法（hour 0-23 / minute 0-59 / weekday 0-6）即收 */
function validateTasks(data: unknown): ScheduleTask[] | null {
  if (!Array.isArray(data)) return null;
  const FREQUENCIES = new Set(["once", "hourly", "daily", "weekday", "weekly"]);
  for (const t of data) {
    if (!t || typeof t !== "object") return null;
    const r = t as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.name !== "string" || typeof r.prompt !== "string") return null;
    if (typeof r.frequency !== "string" || !FREQUENCIES.has(r.frequency)) return null;
    if (typeof r.hour !== "number" || typeof r.minute !== "number" || typeof r.enabled !== "boolean") return null;
    // 值域（评审 R3-C14：minute=999 会进位错乱、weekday=7 会显示「每周undefined」）
    if (!Number.isInteger(r.hour) || r.hour < 0 || r.hour > 23) return null;
    if (!Number.isInteger(r.minute) || r.minute < 0 || r.minute > 59) return null;
    const wd = r.weekday;
    if (wd !== undefined && wd !== null && (typeof wd !== "number" || !Number.isInteger(wd) || wd < 0 || wd > 6)) {
      return null;
    }
  }
  return data as ScheduleTask[];
}

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
    // 结构校验：坏文件先备份 .corrupt-<ts> 再按空表重建，不再静默清空（评审 P2-4）
    this.tasks = readJsonFile(this.file, validateTasks) ?? [];
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
    // tick 内部异常（persist 写盘失败等）不能成为未处理拒绝（评审 R3-C14）
    this.timer = setInterval(
      () => void this.tick().catch((err) => console.warn("[scheduler] tick 失败", err)),
      TICK_MS,
    );
    void this.tick().catch((err) => console.warn("[scheduler] tick 失败", err));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 手动触发一次（试运行）：记账与 tick 同口径（lastRunAt 更新会影响同周期去重——手动跑过就不再补跑） */
  async runNow(id: string): Promise<string> {
    const task = this.list().find((t) => t.id === id);
    if (!task) throw new Error(`任务不存在：${id}`);
    const nowMs = this.opts.now?.() ?? Date.now();
    this.markRun(task.id, nowMs);
    try {
      const sessionId = await this.fireOne(task);
      this.markStatus(task.id, "ok");
      return sessionId;
    } catch (err) {
      this.markStatus(task.id, "error", err instanceof Error ? err.message : String(err));
      throw err;
    }
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
    writeJsonFileAtomic(this.file, this.tasks);
  }
}
