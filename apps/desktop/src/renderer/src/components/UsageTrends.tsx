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

export function UsageTrends({ summary }: { summary: DailyUsage[] }) {
  const [days, setDays] = useState(7);
  const [model, setModel] = useState(ALL_MODELS);

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

  return (
    <>
      {/* Token 趋势曲线 */}
      <section className="mt-6 rounded-2xl border border-border bg-bg-elevated p-6" data-testid="usage-trend">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-text-primary">Token 趋势</h2>
            <p className="mt-0.5 text-[12px] text-text-tertiary">每日 token 消耗曲线（输入 + 输出 + 缓存读写）</p>
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
          <TrendChart dates={dates} series={series} />
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
// 趋势曲线（纯 SVG，viewBox 自适应宽度）
// ---------------------------------------------------------------------------

function TrendChart({ dates, series }: { dates: string[]; series: Series[] }) {
  const W = 840;
  const H = 240;
  const padL = 58;
  const padR = 14;
  const padT = 14;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const hasData = series.length > 0 && max > 0;
  const yMax = niceCeil(max);

  const xAt = (i: number) => (dates.length > 1 ? padL + (i / (dates.length - 1)) * plotW : padL + plotW / 2);
  const yAt = (v: number) => padT + plotH - (v / yMax) * plotH;
  const step = dates.length > 1 ? plotW / (dates.length - 1) : plotW;
  const labelStep = Math.max(1, Math.ceil(dates.length / 6));
  const ticks = [0, 1 / 3, 2 / 3, 1].map((t) => t * yMax);

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="按日 token 消耗趋势曲线"
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

        {/* X 轴日期标签 */}
        {dates.map((d, i) =>
          i % labelStep === 0 || i === dates.length - 1 ? (
            <text
              key={d}
              x={xAt(i)}
              y={H - 8}
              textAnchor="middle"
              fontSize={10}
              fill="var(--color-text-tertiary)"
            >
              {d.slice(5)}
            </text>
          ) : null,
        )}

        {/* 各模型折线 */}
        {hasData &&
          series.map((s, si) => (
            <path
              key={s.key}
              d={s.values.map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`).join(" ")}
              fill="none"
              stroke={chartVar(si)}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

        {/* 每日悬浮命中区：原生 <title> 提示当日各模型明细 */}
        {hasData &&
          dates.map((d, i) => {
            const x1 = Math.max(padL, xAt(i) - step / 2);
            const x2 = Math.min(padL + plotW, xAt(i) + step / 2);
            const total = series.reduce((n, s) => n + (s.values[i] ?? 0), 0);
            const parts = series
              .map((s) => `${s.label} ${formatZh(s.values[i] ?? 0)}`)
              .join("、");
            return (
              <rect key={d} x={x1} y={padT} width={Math.max(0, x2 - x1)} height={plotH} fill="transparent">
                <title>{`${d} · ${formatZh(total)} tokens（${parts}）`}</title>
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

      {/* 多序列时给图例（与环形图一致：色点按序号同源） */}
      {series.length > 1 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 px-2">
          {series.map((s, i) => (
            <span key={s.key} className="flex items-center gap-1.5 text-[11.5px] text-text-tertiary">
              <span className="h-2 w-2 rounded-full" style={{ background: chartVar(i) }} />
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
    <div className="overflow-x-auto pb-1">
      <div className="flex w-max gap-2">
        {/* 左侧周内日标签（首行给月份标签留高） */}
        <div className="flex flex-col gap-[3px]">
          <div className="h-[14px]" />
          {WEEKDAY_LABELS.map((label, r) => (
            <div key={r} className="flex h-3 items-center text-[10px] leading-none text-text-tertiary">
              {label}
            </div>
          ))}
        </div>
        {/* 26 列网格：列为主序，行 = 月份行 + 7 个周内日 */}
        <div
          className="grid gap-[3px]"
          style={{ gridAutoFlow: "column", gridTemplateRows: "14px repeat(7, 12px)" }}
          data-testid="usage-heatmap-grid"
        >
          {slots.map((slot) =>
            slot.kind === "month" ? (
              <div key={slot.id} className="h-[14px] whitespace-nowrap text-[10px] leading-[14px] text-text-tertiary">
                {slot.label}
              </div>
            ) : (
              <div
                key={slot.id}
                className={`h-3 w-3 rounded-[2px] ${slot.future ? "bg-transparent" : HEAT_LEVEL_CLASSES[slot.level]}`}
                title={
                  slot.future ? undefined : slot.tokens > 0 ? `${slot.date} · ${formatZh(slot.tokens)} tokens` : `${slot.date} · 无用量`
                }
              />
            ),
          )}
        </div>
      </div>
    </div>
  );
}
