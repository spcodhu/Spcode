/**
 * 用量页下半区：Token 趋势曲线（日期区间 × 模型筛选）+ GitHub 风格活跃热点图 + 打卡统计。
 * 数据由 UsagePage 经 usageSummary 拉取后传入；纯 SVG / div 实现，不引入图表库。
 */
import { useMemo, useState } from "react";
import {
  addDays,
  buildHeatGrid,
  chartVar,
  computeStreaks,
  dateKeyOf,
  HEAT_WEEKS,
  niceCeil,
  shortModelName,
  stackedDailyMax,
  stackSegments,
  tokensOf,
} from "../chart";
import { formatZh } from "../format";
import { Select } from "./ui/Select";

export type DailyUsage = Awaited<ReturnType<Window["spcode"]["usageSummary"]>>[number];

const TREND_RANGES = [
  { days: 7, label: "最近 7 天" },
  { days: 30, label: "最近 30 天" },
  { days: 100, label: "最近 100 天" },
] as const;

const ALL_MODELS = "all";

interface Series {
  key: string;
  label: string;
  values: number[];
}

export function UsageTrends({
  summary,
  colorIndexOf,
}: {
  summary: DailyUsage[];
  /** 模型 → 稳定色号（与环形图/图例同源，切区间不变色） */
  colorIndexOf: Map<string, number>;
}) {
  const [days, setDays] = useState(7);
  const [model, setModel] = useState(ALL_MODELS);

  /** 序列色号：优先用全局稳定色号；「其他」等合成序列排在最后 */
  const seriesColor = (key: string, fallback: number) => chartVar(colorIndexOf.get(key) ?? 100 + fallback);

  // 窗口日历日（升序，含当天）
  const dates = useMemo(() => {
    const today = new Date();
    return Array.from({ length: days }, (_, i) => dateKeyOf(addDays(today, i - days + 1)));
  }, [days]);

  // 窗口内每日每模型 token
  const daily = useMemo(() => {
    const map = new Map<string, Record<string, number>>();
    const inWindow = new Set(dates);
    for (const day of summary) {
      if (!inWindow.has(day.date)) continue;
      const byModel: Record<string, number> = {};
      for (const [key, agg] of Object.entries(day.byModel)) byModel[key] = tokensOf(agg);
      map.set(day.date, byModel);
    }
    return map;
  }, [summary, dates]);

  // 窗口内有用量的模型（按总量降序）
  const windowModels = useMemo(() => {
    const totals = new Map<string, number>();
    for (const byModel of daily.values()) {
      for (const [k, v] of Object.entries(byModel)) totals.set(k, (totals.get(k) ?? 0) + v);
    }
    return [...totals].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }, [daily]);

  // 下拉选项：窗口内模型 + 当前选中（窗口没数据也保留，避免选择被悄悄重置）
  const modelOptions = useMemo(() => {
    const keys = model === ALL_MODELS || windowModels.includes(model) ? windowModels : [model, ...windowModels];
    return [{ value: ALL_MODELS, label: "全部模型" }, ...keys.map((k) => ({ value: k, label: shortModelName(k) }))];
  }, [windowModels, model]);

  // 曲线序列：全部 = Top5 模型各一条线 + 其余并入「其他」；单选 = 该模型一条线
  const series = useMemo<Series[]>(() => {
    if (daily.size === 0) return [];
    if (model !== ALL_MODELS) {
      return [{ key: model, label: shortModelName(model), values: dates.map((d) => daily.get(d)?.[model] ?? 0) }];
    }
    const out: Series[] = windowModels.slice(0, 5).map((k) => ({
      key: k,
      label: shortModelName(k),
      values: dates.map((d) => daily.get(d)?.[k] ?? 0),
    }));
    const restKeys = windowModels.slice(5);
    if (restKeys.length > 0) {
      out.push({
        key: "__other__",
        label: "其他",
        values: dates.map((d) => {
          const byModel = daily.get(d);
          if (!byModel) return 0;
          return restKeys.reduce((n, k) => n + (byModel[k] ?? 0), 0);
        }),
      });
    }
    return out;
  }, [daily, dates, model, windowModels]);

  // 热点图与打卡统计不吃模型筛选：「打卡」看的是整个 App 有没有被用起来
  const heatTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const day of summary) m.set(day.date, tokensOf(day.total));
    return m;
  }, [summary]);

  const streak = useMemo(() => computeStreaks(summary.map((s) => s.date)), [summary]);

  /** 当前区间+筛选的 token 总量（与柱高同源，不是全局总量） */
  const windowTotal = useMemo(() => {
    let sum = 0;
    for (const d of dates) {
      const byModel = daily.get(d);
      if (!byModel) continue;
      if (model === ALL_MODELS) {
        for (const v of Object.values(byModel)) sum += v;
      } else {
        sum += byModel[model] ?? 0;
      }
    }
    return sum;
  }, [dates, daily, model]);

  const scopeLabel = `${days === 1 ? "今日" : `近 ${days} 天`} · ${model === ALL_MODELS ? "全部模型" : shortModelName(model)}`;

  return (
    <>
      {/* Token 消耗：按模型堆叠的柱状图 */}
      <section className="mt-6 rounded-2xl border border-border bg-bg-elevated p-6" data-testid="usage-trend">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-text-primary">Token 消耗</h2>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span
                className="text-[22px] font-semibold leading-7 text-text-primary tabular-nums"
                data-testid="usage-trend-total"
                title={`${windowTotal.toLocaleString("en-US")} tokens`}
              >
                {formatZh(windowTotal)}
              </span>
              <span className="text-[12px] text-text-tertiary">tokens · {scopeLabel}</span>
            </div>
            <p className="mt-1 text-[12px] text-text-tertiary">
              每日一支柱，柱内颜色为各模型占比（输入 + 输出 + 缓存读写）
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex rounded-full bg-bg-hover p-0.5">
              {TREND_RANGES.map((r) => (
                <button
                  type="button"
                  key={r.days}
                  onClick={() => setDays(r.days)}
                  className={`rounded-full px-3 py-1 text-[12px] transition-colors ${
                    days === r.days ? "bg-accent text-white" : "text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <Select value={model} options={modelOptions} onChange={setModel} className="w-44" />
          </div>
        </div>
        <div className="mt-4">
          <StackedBarChart dates={dates} series={series} seriesColor={seriesColor} />
        </div>
      </section>

      {/* GitHub 风格活跃热点图 + 打卡统计 */}
      <section className="mt-5 rounded-2xl border border-border bg-bg-elevated p-6" data-testid="usage-heatmap">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-text-primary">使用热点图</h2>
            <p className="mt-0.5 text-[12px] text-text-tertiary">
              最近 {HEAT_WEEKS} 周，每格一天，颜色越深当天消耗越多
            </p>
          </div>
          <div className="flex items-center gap-6">
            <StreakStat testId="usage-streak-longest" label="最长连续打卡" value={`${streak.longest} 天`} />
            <StreakStat
              testId="usage-streak-current"
              label="当前连续"
              value={`${streak.current} 天`}
              hint="含今天；今天还没用量则算到昨天"
            />
            <StreakStat testId="usage-streak-total" label="累计打卡" value={`${streak.total} 天`} />
          </div>
        </div>
        <div className="mt-4">
          <Heatmap totals={heatTotals} />
        </div>
        <div className="mt-3 flex items-center gap-1.5 text-[11px] text-text-tertiary">
          <span className="mr-0.5">少</span>
          {HEAT_LEVEL_CLASSES.map((cls) => (
            <span key={cls} className={`h-3 w-3 rounded-[2px] ${cls}`} />
          ))}
          <span className="ml-0.5">多</span>
        </div>
      </section>
    </>
  );
}

function StreakStat({ testId, label, value, hint }: { testId: string; label: string; value: string; hint?: string }) {
  return (
    <div className="text-right" data-testid={testId} title={hint}>
      <div className="text-[18px] font-semibold leading-6 text-text-primary">{value}</div>
      <div className="mt-0.5 text-[11px] text-text-tertiary">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 堆叠柱状图（纯 SVG，viewBox 自适应宽度）
// ---------------------------------------------------------------------------

/**
 * 每天一支柱，柱内按模型堆叠（色号与环形图/图例同源）。
 * 用堆叠柱而不是折线：多模型时一眼能看出「某天是谁把量顶上去了」，
 * 且不会被多条线交叉糊成一团。悬停用原生 <title> 给当日各模型明细。
 */
function StackedBarChart({
  dates,
  series,
  seriesColor,
}: {
  dates: string[];
  series: Series[];
  seriesColor: (key: string, fallback: number) => string;
}) {
  const W = 840;
  const H = 240;
  const padL = 58;
  const padR = 14;
  const padT = 14;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // 刻度必须按「每日堆叠总量」取，不是单序列最大值——否则柱子会顶破最高刻度线
  const max = stackedDailyMax(series.map((s) => s.values));
  const hasData = series.length > 0 && max > 0;
  const yMax = niceCeil(max);

  const yAt = (v: number) => padT + plotH - (v / yMax) * plotH;
  const step = plotW / Math.max(1, dates.length);
  // 柱宽随柱子数量收缩，但至少留 1px 可见；两侧各留 1px 间隙
  const barW = Math.max(1, step - (step > 4 ? 2 : 0.5));
  const xAt = (i: number) => padL + i * step + (step - barW) / 2;
  const labelStep = Math.max(1, Math.ceil(dates.length / 8));
  const ticks = [0, 1 / 3, 2 / 3, 1].map((t) => t * yMax);

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="按日 token 消耗堆叠柱状图"
        data-testid="usage-trend-chart"
      >
        {/* Y 轴刻度线与标签 */}
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={padL}
              x2={W - padR}
              y1={yAt(t)}
              y2={yAt(t)}
              stroke="var(--color-border)"
              strokeWidth={1}
              strokeDasharray={t === 0 ? undefined : "3 4"}
            />
            <text
              x={padL - 8}
              y={yAt(t)}
              textAnchor="end"
              dominantBaseline="central"
              fontSize={10}
              fill="var(--color-text-tertiary)"
            >
              {formatZh(Math.round(t))}
            </text>
          </g>
        ))}

        {/* X 轴日期标签（按需抽稀，100 天窗口也不糊） */}
        {dates.map((d, i) =>
          i % labelStep === 0 || i === dates.length - 1 ? (
            <text
              key={d}
              x={xAt(i) + barW / 2}
              y={H - 8}
              textAnchor="middle"
              fontSize={10}
              fill="var(--color-text-tertiary)"
            >
              {d.slice(5)}
            </text>
          ) : null,
        )}

        {/* 每日堆叠柱：自下而上按序列顺序堆各模型 */}
        {hasData &&
          dates.map((d, i) => {
            const values = series.map((s) => s.values[i] ?? 0);
            const spans = stackSegments(values);
            return (
              <g key={d}>
                {spans.map((sp, si) => {
                  const len = sp.end - sp.start;
                  if (!(len > 0)) return null;
                  const y = yAt(sp.end);
                  const h = Math.max(0.5, yAt(sp.start) - y);
                  const s = series[si];
                  if (!s) return null;
                  return (
                    <rect
                      key={s.key}
                      x={xAt(i)}
                      y={y}
                      width={barW}
                      height={h}
                      fill={seriesColor(s.key, si)}
                      data-testid="usage-bar-seg"
                      data-model={s.key}
                    />
                  );
                })}
              </g>
            );
          })}

        {/* 每日悬浮命中区：原生 <title> 提示当日各模型明细 */}
        {hasData &&
          dates.map((d, i) => {
            const total = series.reduce((n, s) => n + (s.values[i] ?? 0), 0);
            const parts = series
              .filter((s) => (s.values[i] ?? 0) > 0)
              .map((s) => `${s.label} ${formatZh(s.values[i] ?? 0)}`)
              .join("、");
            return (
              <rect key={`hit-${d}`} x={padL + i * step} y={padT} width={step} height={plotH} fill="transparent">
                <title>{`${d} · ${formatZh(total)} tokens${parts ? `（${parts}）` : ""}`}</title>
              </rect>
            );
          })}

        {!hasData && (
          <text
            x={W / 2}
            y={H / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={13}
            fill="var(--color-text-tertiary)"
          >
            该区间暂无用量记录
          </text>
        )}
      </svg>

      {/* 多序列时给图例（色点与环形图/柱内分段同源色号） */}
      {series.length > 1 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 px-2">
          {series.map((s, i) => (
            <span key={s.key} className="flex items-center gap-1.5 text-[11.5px] text-text-tertiary">
              <span className="h-2 w-2 rounded-full" style={{ background: seriesColor(s.key, i) }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GitHub 风格活跃热点图（div 网格）
// ---------------------------------------------------------------------------

/** 0..4 级配色：0 = 空档，1..4 = accent 由浅到深 */
const HEAT_LEVEL_CLASSES = ["bg-bg-hover", "bg-accent/25", "bg-accent/45", "bg-accent/70", "bg-accent"];

const WEEKDAY_LABELS = ["周一", "", "周三", "", "周五", "", ""];

function Heatmap({ totals }: { totals: Map<string, number> }) {
  const slots = useMemo(() => buildHeatGrid(totals), [totals]);
  return (
    <div className="w-full">
      {/* 单一网格拉满卡片宽：第 1 列 = 周内日标签，后 26 列 = 月份行 + 7 天格子（列主序）。
          列宽 1fr、格子 aspect-square：格子随可用宽度等比放大并保持正方形 */}
      <div
        className="grid gap-[3px]"
        style={{
          gridAutoFlow: "column",
          gridTemplateColumns: `auto repeat(${HEAT_WEEKS}, minmax(0, 1fr))`,
          gridTemplateRows: "14px repeat(7, auto)",
        }}
        data-testid="usage-heatmap-grid"
      >
        <div />
        {WEEKDAY_LABELS.map((label, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 星期标签是固定 7 项静态数组，顺序永不变
          <div key={r} className="flex items-center justify-end pr-1.5 text-[10px] leading-none text-text-tertiary">
            {label}
          </div>
        ))}
        {slots.map((slot) =>
          slot.kind === "month" ? (
            <div key={slot.id} className="h-[14px] whitespace-nowrap text-[10px] leading-[14px] text-text-tertiary">
              {slot.label}
            </div>
          ) : (
            <div
              key={slot.id}
              className={`aspect-square w-full rounded-[2px] ${
                slot.future ? "bg-transparent" : HEAT_LEVEL_CLASSES[slot.level]
              }`}
              title={
                slot.future
                  ? undefined
                  : slot.tokens > 0
                    ? `${slot.date} · ${formatZh(slot.tokens)} tokens`
                    : `${slot.date} · 无用量`
              }
            />
          ),
        )}
      </div>
    </div>
  );
}
