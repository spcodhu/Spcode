import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScheduledRunRetry } from "@spcode/shared";
import { afterAll, describe, expect, it, vi } from "vitest";
import { RunRetryScheduler } from "../src/main/run-retry.js";

const dir = mkdtempSync(join(tmpdir(), "spcode-run-retry-"));
let sequence = 0;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function setup(fire: (retry: ScheduledRunRetry) => Promise<boolean>, now: () => number) {
  const file = join(dir, `retries-${++sequence}.json`);
  const notify = vi.fn();
  const onError = vi.fn();
  const scheduler = new RunRetryScheduler({ file, fire, now, notify, onError });
  return { scheduler, file, notify, onError };
}

function input(runAt: number) {
  return { sessionId: "s1", text: "继续执行", runAt };
}

describe("会话错误定时重试", () => {
  it("持久化精确时间；同会话新选择替换旧选择，取消可落盘", () => {
    const now = 1_000_000;
    const { scheduler, file } = setup(
      async () => true,
      () => now,
    );
    scheduler.schedule(input(now + 3_600_000));
    const replacement = scheduler.schedule(input(now + 7_200_000));
    expect(scheduler.list()).toHaveLength(1);
    expect(scheduler.list()[0]?.id).toBe(replacement.id);
    const restored = new RunRetryScheduler({ file, fire: async () => true });
    expect(restored.list()[0]).toMatchObject({ sessionId: "s1", text: "继续执行", runAt: now + 7_200_000 });
    restored.cancel(replacement.id);
    expect(new RunRetryScheduler({ file, fire: async () => true }).list()).toEqual([]);
  });

  it("未到点不执行；到点接受后删除并通知", async () => {
    let now = 1_000_000;
    const fire = vi.fn(async () => true);
    const { scheduler, notify } = setup(fire, () => now);
    const retry = scheduler.schedule(input(now + 60_000));
    await scheduler.tick();
    expect(fire).not.toHaveBeenCalled();
    now += 60_000;
    await scheduler.tick();
    expect(fire).toHaveBeenCalledWith(expect.objectContaining({ id: retry.id }));
    expect(scheduler.list()).toEqual([]);
    expect(notify).toHaveBeenLastCalledWith([]);
  });

  it("会话忙时顺延一分钟且不消耗派发次数", async () => {
    let now = 1_000_000;
    let busy = true;
    const fire = vi.fn(async () => !busy);
    const { scheduler } = setup(fire, () => now);
    scheduler.schedule(input(now));
    await scheduler.tick();
    expect(scheduler.list()[0]?.runAt).toBe(now + 60_000);
    expect(scheduler.list()[0]?.dispatchAttempts).toBeUndefined();
    now += 60_000;
    busy = false;
    await scheduler.tick();
    expect(fire).toHaveBeenCalledTimes(2);
    expect(scheduler.list()).toEqual([]);
  });

  it("宿主派发失败最多补派三次，最终错误不伪装成功", async () => {
    let now = 1_000_000;
    const error = new Error("host offline");
    const { scheduler, onError } = setup(
      async () => Promise.reject(error),
      () => now,
    );
    scheduler.schedule(input(now));
    await scheduler.tick();
    expect(scheduler.list()[0]).toMatchObject({ dispatchAttempts: 1, runAt: now + 60_000 });
    now += 60_000;
    await scheduler.tick();
    expect(scheduler.list()[0]).toMatchObject({ dispatchAttempts: 2, runAt: now + 120_000 });
    now += 120_000;
    await scheduler.tick();
    expect(scheduler.list()).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }), "host offline");
  });

  it("拒绝没有内容或图片损坏的重试", () => {
    const { scheduler } = setup(
      async () => true,
      () => 1_000_000,
    );
    expect(() => scheduler.schedule({ sessionId: "s1", text: "", runAt: 1 })).toThrow();
    expect(() =>
      scheduler.schedule({
        sessionId: "s1",
        text: "x",
        runAt: 1,
        images: [{ name: "bad.png", mimeType: "image/png", data: "bad!" }],
      }),
    ).toThrow();
  });
});
