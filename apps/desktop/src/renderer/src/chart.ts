/** 图表与日期公用工具（用量页环形图 / 趋势曲线 / 热点图共用） */
import type { UsageAggregate } from "@spcode/shared";

export const CHART_COLORS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6"] as const;

/** 色板 CSS 变量引用（样式表 :root 里定义，随主题无关） */
export function chartVar(i: number): string {
  return `var(${CHART_COLORS[i % CHART_COLORS.length]})`;
}

/** provider/modelId → 末段短名（超长截断） */
export function shortModelName(model: string): string {
  const id = model.split("/").pop() ?? model;
  return id.length > 24 ? `${id.slice(0, 24)}…` : id;
}

/** 聚合口径的 token 总量（输入 + 输出 + 缓存读写） */
export function tokensOf(agg: UsageAggregate): number {
  return agg.input + agg.output + agg.cacheRead + agg.cacheWrite;
}

/** 本地时区 YYYY-MM-DD（与主进程 UsageLedger.dateOf 同一口径） */
export function dateKeyOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 日期偏移（不共享 Date 实例，避免原地改动） */
export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** YYYY-MM-DD → 距 epoch 的整天数（按 UTC 零点解析，日历日差值不受时区/夏令时影响） */
export function dayNumOf(key: string): number {
  const parts = key.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/** 向上取整到 1/2/2.5/5×10^k 的“好看”刻度 */
export function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/** 连续打卡统计：最长连续 / 当前连续（今天没记录则算到昨天）/ 累计打卡天数 */
export function computeStreaks(dateKeys: string[]): { longest: number; current: number; total: number } {
  const nums = [...new Set(dateKeys.map(dayNumOf))].sort((a, b) => a - b);
  const set = new Set(nums);
  let longest = 0;
  let run = 0;
  let prev = -Infinity;
  for (const n of nums) {
    run = n === prev + 1 ? run + 1 : 1;
    prev = n;
    if (run > longest) longest = run;
  }
  const todayNum = dayNumOf(dateKeyOf(new Date()));
  let cursor = set.has(todayNum) ? todayNum : todayNum - 1;
  let current = 0;
  while (set.has(cursor)) {
    current++;
    cursor--;
  }
  return { longest, current, total: nums.length };
}

export type HeatSlot =
  | { kind: "month"; id: string; label: string | null }
  | { kind: "day"; id: string; date: string; tokens: number; level: number; future: boolean };

/** 热点图默认窗口：最近 26 周（列 = 周，周一为行首） */
export const HEAT_WEEKS = 26;

/**
 * GitHub 风格热点网格：列为主序（每月列先放月份标签，再放 7 个周内日格子）。
 * 等级 0..4 按窗口内非零日总量的分位数划分（对离群值比按最大值切桶更稳）。
 */
export function buildHeatGrid(totals: Map<string, number>, weeks = HEAT_WEEKS): HeatSlot[] {
  const today = new Date();
  const dow = (today.getDay() + 6) % 7; // 周一 = 0
  const gridStart = addDays(addDays(today, -dow), -(weeks - 1) * 7);
  const todayNum = dayNumOf(dateKeyOf(today));

  const active: number[] = [];
  for (let c = 0; c < weeks; c++) {
    for (let r = 0; r < 7; r++) {
      const t = totals.get(dateKeyOf(addDays(gridStart, c * 7 + r))) ?? 0;
      if (t > 0) active.push(t);
    }
  }
  active.sort((a, b) => a - b);
  // 按排名分 4 档：重复值同取最大下标，保证最高档可达；单点历史直接给满档
  const idxOf = new Map<number, number>();
  active.forEach((v, i) => idxOf.set(v, i));
  const levelOf = (t: number): number => {
    if (t <= 0) return 0;
    if (active.length === 1) return 4;
    const i = idxOf.get(t) ?? 0;
    return Math.min(4, 1 + Math.floor((i / (active.length - 1)) * 4));
  };

  const slots: HeatSlot[] = [];
  let prevMonth = -1;
  for (let c = 0; c < weeks; c++) {
    const monday = addDays(gridStart, c * 7);
    // 月份标签按整周判定（取周日）：月初 1 号在周中时标签打在「含 1 号的那一周」，与 GitHub 一致
    const weekEnd = addDays(monday, 6);
    const m = weekEnd.getMonth();
    slots.push({ kind: "month", id: `m${c}`, label: m !== prevMonth ? `${m + 1}月` : null });
    prevMonth = m;
    for (let r = 0; r < 7; r++) {
      const date = addDays(monday, r);
      const key = dateKeyOf(date);
      const tokens = totals.get(key) ?? 0;
      slots.push({ kind: "day", id: key, date: key, tokens, level: levelOf(tokens), future: dayNumOf(key) > todayNum });
    }
  }
  return slots;
}
