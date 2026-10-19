/** chart.ts 纯逻辑单测：日期换算、刻度取整、连续打卡、热点网格、饼图扇区/色号 */
import { describe, expect, it } from "vitest";
import {
  addDays,
  buildHeatGrid,
  chartVar,
  computeStreaks,
  dateKeyOf,
  dayNumOf,
  donutSegments,
  formatShare,
  HEAT_WEEKS,
  modelColorIndex,
  niceCeil,
  stackedDailyMax,
  stackSegments,
} from "../src/renderer/src/chart.js";

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
  it("周数网格 = 周数 × (1 个月份槽 + 7 个日期槽)", () => {
    const slots = buildHeatGrid(new Map());
    expect(slots).toHaveLength(HEAT_WEEKS * 8);
    expect(slots.filter((s) => s.kind === "month")).toHaveLength(HEAT_WEEKS);
    expect(slots.filter((s) => s.kind === "day")).toHaveLength(HEAT_WEEKS * 7);
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

describe("donutSegments", () => {
  it("极小占比也要拿到最小扇区（否则饼图会“只剩两种颜色”）", () => {
    // 2.02亿 / 6780万 / 57.2万：旧实现第三段弧长为 0，完全不可见
    const fractions = donutSegments([202_000_000, 67_800_000, 572_000]);
    expect(fractions).toHaveLength(3);
    for (const f of fractions) expect(f).toBeGreaterThanOrEqual(0.012 - 1e-9);
    expect(fractions.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it("0 值不占扇区（返回 0，总和仍为 1）", () => {
    const fractions = donutSegments([100, 0, 300]);
    expect(fractions[1]).toBe(0);
    expect(fractions[0] + fractions[1] + fractions[2]).toBeCloseTo(1, 9);
    expect(fractions[2]).toBeGreaterThan(fractions[0]);
  });

  it("全零/空输入返回全 0，不产生 NaN", () => {
    expect(donutSegments([])).toEqual([]);
    expect(donutSegments([0, 0])).toEqual([0, 0]);
  });

  it("模型数很多时最小扇区自动收敛，总和不会超过 1", () => {
    const many = Array.from({ length: 200 }, (_, i) => (i === 0 ? 1_000_000 : 1));
    const fractions = donutSegments(many);
    expect(fractions.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    for (const f of fractions) expect(f).toBeGreaterThan(0);
    for (const f of fractions) expect(f).toBeLessThan(1);
  });
});

describe("modelColorIndex", () => {
  it("按用量降序分配且稳定（同量按名字）", () => {
    const idx = modelColorIndex(
      new Map([
        ["b/model", 10],
        ["a/model", 10],
        ["c/model", 30],
      ]),
    );
    expect(idx.get("c/model")).toBe(0);
    expect(idx.get("a/model")).toBe(1);
    expect(idx.get("b/model")).toBe(2);
  });

  it("不同区间只影响传入的总量，但排序函数本身不依赖区间顺序（同一总量→同一色号）", () => {
    const all = modelColorIndex(
      new Map([
        ["k3", 202_000_000],
        ["deepseek-flash", 67_800_000],
        ["mimo-v2.6-pro", 572_000],
      ]),
    );
    const again = modelColorIndex(
      new Map([
        ["mimo-v2.6-pro", 572_000],
        ["k3", 202_000_000],
        ["deepseek-flash", 67_800_000],
      ]),
    );
    expect(again).toEqual(all);
    expect(all.get("k3")).toBe(0);
  });
});

describe("chartVar", () => {
  it("12 色之内用样式表变量，超出后派生 HSL（不与已有色号重复）", () => {
    expect(chartVar(0)).toBe("var(--chart-1)");
    expect(chartVar(11)).toBe("var(--chart-12)");
    const beyond = chartVar(12);
    expect(beyond).toMatch(/^hsl\(/);
    expect(chartVar(13)).not.toBe(beyond);
  });

  it("负值/小数色号不越界", () => {
    expect(chartVar(-3)).toBe("var(--chart-1)");
    expect(chartVar(1.7)).toBe("var(--chart-2)");
  });
});

describe("formatShare", () => {
  it("极小但非零的占比显示 <1%，不四舍五入成 0%", () => {
    expect(formatShare(572_000, 270_000_000)).toBe("<1%");
    expect(formatShare(67_800_000, 270_000_000)).toBe("25%");
    expect(formatShare(0, 100)).toBe("0%");
    expect(formatShare(1, 0)).toBe("—");
  });
});

describe("stackedDailyMax", () => {
  it("按每日堆叠总量取最大值（不是单序列最大值）", () => {
    // 第 3 天：单序列最大 40，但堆叠总量 100 —— 刻度必须能容下 100
    expect(
      stackedDailyMax([
        [10, 20, 40],
        [5, 10, 30],
        [1, 2, 30],
      ]),
    ).toBe(100);
  });

  it("空/非法值不参与计算", () => {
    expect(stackedDailyMax([])).toBe(0);
    expect(stackedDailyMax([[], []])).toBe(0);
    expect(stackedDailyMax([[Number.NaN, -5, 7]])).toBe(7);
  });
});

describe("stackSegments", () => {
  it("累计区间从下往上堆叠，忽略非正值", () => {
    expect(stackSegments([10, 20, 30])).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 30 },
      { start: 30, end: 60 },
    ]);
    expect(stackSegments([5, -1, Number.NaN, 5])).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 5 },
      { start: 5, end: 5 },
      { start: 5, end: 10 },
    ]);
  });
});
