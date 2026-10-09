import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HibernationManager } from "../src/agent-host/hibernation.js";

/**
 * 非活动会话休眠管理：宽限期计时 + 防抖动 + canSleep 门禁。
 * 保护的行为：
 * - 请求后到期才真正 sleep（宽限期内不释放，来回切换不重建引擎）
 * - 宽限期内 cancel / 重新 request 都阻止本次释放
 * - canSleep=false（运行中）时 request 直接拒绝
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HibernationManager", () => {
  it("到期才执行 sleep，宽限期内不释放", () => {
    const sleep = vi.fn();
    const h = new HibernationManager({ graceMs: 30_000, sleep });
    expect(h.request("s1")).toBe(true);
    expect(h.pending("s1")).toBe(true);

    vi.advanceTimersByTime(29_999);
    expect(sleep).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith("s1");
    expect(h.pending("s1")).toBe(false);
  });

  it("宽限期内 cancel 阻止释放（切回会话不重建）", () => {
    const sleep = vi.fn();
    const h = new HibernationManager({ graceMs: 30_000, sleep });
    h.request("s1");
    vi.advanceTimersByTime(10_000);
    h.cancel("s1");
    expect(h.pending("s1")).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("重复 request 重置计时（连续切走以最后一次为准）", () => {
    const sleep = vi.fn();
    const h = new HibernationManager({ graceMs: 30_000, sleep });
    h.request("s1");
    vi.advanceTimersByTime(25_000);
    h.request("s1"); // 重新计时
    vi.advanceTimersByTime(25_000);
    expect(sleep).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("canSleep=false 时拒睡（运行中的会话不休眠）", () => {
    const sleep = vi.fn();
    const h = new HibernationManager({ graceMs: 1000, sleep, canSleep: () => false });
    expect(h.request("s1")).toBe(false);
    expect(h.pending("s1")).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("sleep 抛异常不影响其他会话的计时", async () => {
    const sleep = vi.fn((id: string) => {
      if (id === "bad") return Promise.reject(new Error("boom"));
      return Promise.resolve();
    });
    const h = new HibernationManager({ graceMs: 1000, sleep });
    h.request("bad");
    h.request("good");
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(2));
    expect(sleep).toHaveBeenCalledWith("good");
  });

  it("disposeAll 清空全部待决计时", () => {
    const sleep = vi.fn();
    const h = new HibernationManager({ graceMs: 1000, sleep });
    h.request("s1");
    h.request("s2");
    h.disposeAll();
    expect(h.pending("s1")).toBe(false);
    expect(h.pending("s2")).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(sleep).not.toHaveBeenCalled();
  });
});
