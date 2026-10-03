/** chart.ts 纯逻辑单测：日期换算、刻度取整、连续打卡、热点网格 */
import { describe, expect, it } from "vitest";
import { addDays, buildHeatGrid, computeStreaks, dateKeyOf, dayNumOf, niceCeil } from "../src/renderer/src/chart.js";

const today = new Date();
const key = (offset: number) => dateKeyOf(addDays(today, offset));

describe("dayNumOf / dateKeyOf", () => {
  it("相邻日历日整天数差 1（跨月/跨年/DST 均成立）", () => {
    expect(dayNumOf("2026-03-01") - dayNumOf("2026-02-28")).toBe(1);
    expect(dayNumOf("2026-01-01") - dayNumOf("2025-12-31")).toBe(1);
  });
});

describe("niceCeil", () => {
  it("向上取整到 1/2/2.5/5×10^k", () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(120)).toBe(200);
    expect(niceCeil(2400)).toBe(2500);
    expect(niceCeil(450)).toBe(500);
    expect(niceCeil(9)).toBe(10);
  });
});

describe("computeStreaks", () => {
  it("空历史返回全 0", () => {
    expect(computeStreaks([])).toEqual({ longest: 0, current: 0, total: 0 });
  });

  it("今天有记录：当前连续与最长连续都从今天回溯", () => {
    // 两段连续：-9..-7 与 -3..0，最长 4，当前 4，累计 7
    const dates = [-9, -8, -7, -3, -2, -1, 0].map(key);
    expect(computeStreaks(dates)).toEqual({ longest: 4, current: 4, total: 7 });
  });

  it("今天还没记录但昨天有：连续算到昨天", () => {
    const dates = [-3, -2, -1].map(key);
    expect(computeStreaks(dates)).toEqual({ longest: 3, current: 3, total: 3 });
  });

  it("今天与昨天都断了：当前连续归零", () => {
    const dates = [-5, -4].map(key);
    expect(computeStreaks(dates)).toEqual({ longest: 2, current: 0, total: 2 });
  });

  it("重复日期去重", () => {
    expect(computeStreaks([key(0), key(0)])).toEqual({ longest: 1, current: 1, total: 1 });
  });
});

describe("buildHeatGrid", () => {
  it("26 周网格 = 26 个月份槽 + 182 个日期槽", () => {
    const slots = buildHeatGrid(new Map());
    expect(slots).toHaveLength(26 * 8);
    expect(slots.filter((s) => s.kind === "month")).toHaveLength(26);
    expect(slots.filter((s) => s.kind === "day")).toHaveLength(182);
  });

  it("空数据全为 0 档；今天不是未来，今天之后是未来", () => {
    const slots = buildHeatGrid(new Map()).filter((s) => s.kind === "day");
    const todayKey = dateKeyOf(today);
    for (const s of slots) {
      if (s.kind !== "day") continue;
      expect(s.level).toBe(0);
      expect(s.future).toBe(s.date > todayKey);
    }
    expect(slots.find((s) => s.kind === "day" && s.date === todayKey)?.future).toBe(false);
  });

  it("按排名分档：最高值拿满档，档位在 0..4", () => {
    const todayKey = dateKeyOf(today);
    const totals = new Map([
      [todayKey, 10_000],
      [key(-1), 100],
      [key(-2), 1_000],
      [key(-3), 10],
    ]);
    const days = buildHeatGrid(totals).filter((s) => s.kind === "day");
    const byDate = new Map(days.map((s) => [s.date, s.level]));
    expect(byDate.get(todayKey)).toBe(4);
    expect(byDate.get(key(-3))).toBe(1);
    for (const s of days) expect(s.level).toBeGreaterThanOrEqual(0);
    for (const s of days) expect(s.level).toBeLessThanOrEqual(4);
  });

  it("单点历史直接给满档", () => {
    const todayKey = dateKeyOf(today);
    const days = buildHeatGrid(new Map([[todayKey, 500]])).filter((s) => s.kind === "day");
    expect(days.find((s) => s.date === todayKey)?.level).toBe(4);
  });
});
