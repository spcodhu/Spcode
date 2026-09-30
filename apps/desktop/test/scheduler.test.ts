/**
 * 定时任务调度器单测：isDue 到点判定（五种频率）+ tick 触发/补跑/错误语义。
 * 持久化指向临时文件；时钟与 fire 全部注入。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ScheduleTask } from "@spcode/shared";
import { isDue, Scheduler } from "../src/main/scheduler.js";

let dir = "";

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function makeTask(patch: Partial<ScheduleTask>): ScheduleTask {
  return {
    id: "t1",
    name: "测试任务",
    prompt: "做点事",
    target: { kind: "chat" },
    frequency: "daily",
    hour: 9,
    minute: 0,
    enabled: true,
    createdAt: 0,
    ...patch,
  };
}

// 2026-09-28 是周一
const MON = new Date(2026, 8, 28, 10, 0, 0).getTime();
const SAT = new Date(2026, 9, 3, 10, 0, 0).getTime(); // 2026-10-03 周六

describe("isDue 到点判定", () => {
  it("once：到达 runAt 且未跑过才触发", () => {
    const t = makeTask({ frequency: "once", runAt: MON - 60_000 });
    expect(isDue(t, MON)).toBe(true);
    expect(isDue({ ...t, lastRunAt: MON - 30_000 }, MON)).toBe(false);
    expect(isDue({ ...t, runAt: MON + 60_000 }, MON)).toBe(false);
  });

  it("hourly：过了本小时的 minute 且本小时未跑", () => {
    const t = makeTask({ frequency: "hourly", minute: 30 });
    expect(isDue(t, new Date(2026, 8, 28, 10, 45).getTime())).toBe(true);
    expect(isDue(t, new Date(2026, 8, 28, 10, 15).getTime())).toBe(false);
    // 本小时 10:31 已跑过 → 不再跑
    expect(isDue({ ...t, lastRunAt: new Date(2026, 8, 28, 10, 31).getTime() }, new Date(2026, 8, 28, 10, 45).getTime())).toBe(false);
    // 上一小时跑的 → 本小时该跑
    expect(isDue({ ...t, lastRunAt: new Date(2026, 8, 28, 9, 31).getTime() }, new Date(2026, 8, 28, 10, 45).getTime())).toBe(true);
  });

  it("daily：过了今日时刻且今日未跑", () => {
    const t = makeTask({ frequency: "daily", hour: 9, minute: 0 });
    expect(isDue(t, MON)).toBe(true); // 周一 10:00，已过 9:00
    expect(isDue(t, new Date(2026, 8, 28, 8, 59).getTime())).toBe(false);
    expect(isDue({ ...t, lastRunAt: new Date(2026, 8, 28, 9, 0, 5).getTime() }, MON)).toBe(false);
    // 昨天跑的 → 今天该跑
    expect(isDue({ ...t, lastRunAt: new Date(2026, 8, 27, 9, 0).getTime() }, MON)).toBe(true);
  });

  it("weekday：周末不触发", () => {
    const t = makeTask({ frequency: "weekday", hour: 9, minute: 0 });
    expect(isDue(t, MON)).toBe(true);
    expect(isDue(t, SAT)).toBe(false);
  });

  it("weekly：只在指定周日触发", () => {
    const t = makeTask({ frequency: "weekly", weekday: 1, hour: 9, minute: 0 });
    expect(isDue(t, MON)).toBe(true); // 周一
    expect(isDue(t, new Date(2026, 8, 29, 10, 0).getTime())).toBe(false); // 周二
  });

  it("disabled 永不触发", () => {
    expect(isDue(makeTask({ enabled: false }), MON)).toBe(false);
  });
});

describe("Scheduler.tick", () => {
  function setup(fire: (t: ScheduleTask) => Promise<string>, now: () => number) {
    dir = dir || mkdtempSync(join(tmpdir(), "spcode-sched-"));
    const file = join(dir, `schedules-${Math.random().toString(36).slice(2)}.json`);
    const fired: string[] = [];
    const notified: string[] = [];
    const sched = new Scheduler({
      file,
      now,
      fire: async (t) => {
        fired.push(t.id);
        return fire(t);
      },
      notify: (t, sessionId) => notified.push(`${t.id}:${sessionId}`),
    });
    return { sched, fired, notified, file };
  }

  it("到点触发一次：标记 lastRunAt、广播通知，同周期再 tick 不重复", async () => {
    const { sched, fired, notified } = setup(async () => "sess-1", () => MON);
    sched.create({ name: "晨报", prompt: "早报", target: { kind: "chat" }, frequency: "daily", hour: 9, minute: 0, enabled: true });
    await sched.tick();
    expect(fired).toHaveLength(1);
    expect(notified).toEqual([`${sched.list()[0].id}:sess-1`]);
    expect(sched.list()[0].lastRunAt).toBe(MON);
    expect(sched.list()[0].lastStatus).toBe("ok");
    await sched.tick();
    expect(fired).toHaveLength(1);
  });

  it("once 触发后自动停用", async () => {
    const { sched } = setup(async () => "s", () => MON);
    sched.create({ name: "单次", prompt: "p", target: { kind: "chat" }, frequency: "once", hour: 0, minute: 0, runAt: MON - 1000, enabled: true });
    await sched.tick();
    const t = sched.list()[0];
    expect(t.enabled).toBe(false);
    expect(t.lastStatus).toBe("ok");
  });

  it("fire 失败记 error 且当周期不重试（lastRunAt 已占位）", async () => {
    const { sched, fired } = setup(async () => {
      throw new Error("引擎炸了");
    }, () => MON);
    sched.create({ name: "会失败", prompt: "p", target: { kind: "chat" }, frequency: "daily", hour: 9, minute: 0, enabled: true });
    await sched.tick();
    expect(fired).toHaveLength(1);
    expect(sched.list()[0].lastStatus).toBe("error");
    expect(sched.list()[0].lastError).toContain("引擎炸了");
    await sched.tick();
    expect(fired).toHaveLength(1);
  });

  it("runNow 手动触发：不影响周期占位，只记状态", async () => {
    const { sched, fired } = setup(async () => "s-manual", () => MON);
    const t = sched.create({ name: "手动", prompt: "p", target: { kind: "chat" }, frequency: "daily", hour: 20, minute: 0, enabled: true });
    await sched.runNow(t.id);
    expect(fired).toEqual([t.id]);
    // 晚上 20:00 到点时仍应正常触发（runNow 不占周期）
    const { lastRunAt } = sched.list()[0];
    expect(lastRunAt).toBeUndefined();
  });

  it("CRUD 与持久化：更新/删除落盘，新实例能读回", async () => {
    const { sched, file } = setup(async () => "s", () => MON);
    const t = sched.create({ name: "A", prompt: "p", target: { kind: "chat" }, frequency: "daily", hour: 9, minute: 0, enabled: true });
    sched.update(t.id, { name: "B", enabled: false });
    const reloaded = new Scheduler({ file, fire: async () => "s" });
    expect(reloaded.list()[0].name).toBe("B");
    expect(reloaded.list()[0].enabled).toBe(false);
    reloaded.remove(t.id);
    expect(new Scheduler({ file, fire: async () => "s" }).list()).toHaveLength(0);
  });
});
