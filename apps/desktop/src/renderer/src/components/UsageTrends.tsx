import { getLocale } from "@spcode/shared/i18n";
/**
 * 用量页下半区：Token 趋势曲线（日期区间 × 模型筛选）+ GitHub 风格活跃热点图 + 打卡统计。
 * 数据由 UsagePage 经 usageSummary 拉取后传入；纯 SVG / div 实现，不引入图表库。
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  addDays,
  buildHeatGrid,
  chartVar,
  computeStreaks,
  dateKeyOf,
  HEAT_WEEKS,
  niceScale,
  shortModelName,
  stackedDailyMax,
  stackSegments,
  tokensOf,
} from "../chart";
import { formatDateKey, formatZh } from "../format";
import { ChartDot, useChartTip } from "./ChartTip";
import { Select } from "./ui/Select";

export type DailyUsage = Awaited<ReturnType<Window["spcode"]["usageSummary"]>>[number];

const TREND_RANGES = [7, 30, 100] as const;

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
  const { t } = useTranslation("settings");
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
    return [
      { value: ALL_MODELS, label: t("usage.allModels") },
      ...keys.map((k) => ({ value: k, label: shortModelName(k) })),
    ];
  }, [windowModels, model, t]);

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
        label: t("usage.other"),
        values: dates.map((d) => {
          const byModel = daily.get(d);
          if (!byModel) return 0;
          return restKeys.reduce((n, k) => n + (byModel[k] ?? 0), 0);
        }),
      });
    }
    return out;
  }, [daily, dates, model, windowModels, t]);

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

  const scopeLabel = `${days === 1 ? t("usage.today") : t("usage.recentDays", { count: days })} · ${model === ALL_MODELS ? t("usage.allModels") : shortModelName(model)}`;

  return (
    <>
      {/* Token 消耗：按模型堆叠的柱状图 */}
      <section className="mt-6 rounded-2xl border border-border bg-bg-elevated p-6" data-testid="usage-trend">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-text-primary">{t("usage.consumption")}</h2>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span
                className="text-[22px] font-semibold leading-7 text-text-primary tabular-nums"
                data-testid="usage-trend-total"
                title={t("usage.tokens", { value: windowTotal.toLocaleString(getLocale()) })}
              >
                {formatZh(windowTotal)}
              </span>
              <span className="text-[12px] text-text-tertiary">
                {t("usage.tokensWithScope", { scope: scopeLabel })}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <div className="flex h-9 items-center rounded-full bg-bg-hover p-1">
              {TREND_RANGES.map((r) => (
                <button
                  type="button"
                  key={r}
                  onClick={() => setDays(r)}
                  aria-pressed={days === r}
                  className={`h-7 rounded-full px-3 text-[12px] transition-colors ${
                    days === r ? "bg-accent text-on-accent" : "text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {t("usage.daysRange", { count: r })}
                </button>
              ))}
            </div>
            <Select value={model} options={modelOptions} onChange={setModel} className="w-44" />
          </div>
        </div>
        <p className="mt-2 text-[12px] leading-5 text-text-tertiary">{t("usage.chartDescription")}</p>
        <div className="mt-4">
          <StackedBarChart dates={dates} series={series} seriesColor={seriesColor} />
        </div>
      </section>

      {/* GitHub 风格活跃热点图 + 打卡统计 */}
      <section className="mt-5 rounded-2xl border border-border bg-bg-elevated p-6" data-testid="usage-heatmap">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-text-primary">{t("usage.heatmap")}</h2>
            <p className="mt-0.5 text-[12px] text-text-tertiary">
              {t("usage.heatmapDescription", { count: HEAT_WEEKS })}
            </p>
          </div>
          <div className="flex items-center gap-6">
            <StreakStat
              testId="usage-streak-longest"
              label={t("usage.longestStreak")}
              value={t("usage.days", { count: streak.longest })}
            />
            <StreakStat
              testId="usage-streak-current"
              label={t("usage.currentStreak")}
              value={t("usage.days", { count: streak.current })}
              hint={t("usage.streakHint")}
            />
            <StreakStat
              testId="usage-streak-total"
              label={t("usage.totalDays")}
              value={t("usage.days", { count: streak.total })}
            />
          </div>
        </div>
        <div className="mt-4">
          <Heatmap totals={heatTotals} />
        </div>
        <div className="mt-3 flex items-center gap-1.5 text-[11px] text-text-tertiary">
          <span className="mr-0.5">{t("usage.less")}</span>
          {HEAT_LEVEL_CLASSES.map((cls) => (
            <span key={cls} className={`h-3 w-3 rounded-[2px] ${cls}`} />
          ))}
          <span className="ml-0.5">{t("usage.more")}</span>
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
  const { t } = useTranslation("settings");
  const tip = useChartTip();
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
  const scale = niceScale(max);
  const yMax = scale.max;

  const yAt = (v: number) => padT + plotH - (v / yMax) * plotH;
  const step = plotW / Math.max(1, dates.length);
  // 柱宽随日期槽收缩，但 7 天视图也不撑满；最多 56px，保留足够负空间。
  const barW = Math.max(1, Math.min(56, step * 0.68));
  const xAt = (i: number) => padL + i * step + (step - barW) / 2;
  const labelStep = Math.max(1, Math.ceil(dates.length / 8));
  const ticks = scale.ticks;
  // 当前高亮的日（悬浮优先，其次点击锁定）：其余日变暗，只留当日与模型明细
  const activeIdx = tip.activeId ? dates.indexOf(tip.activeId) : -1;

  /** 提示卡片内容：当日总量 + 各模型构成（色点与柱内分段同源） */
  const bodyOf = (id: string) => {
    const i = dates.indexOf(id);
    if (i < 0) return null;
    const rows = series
      .map((s, si) => ({ key: s.key, label: s.label, value: s.values[i] ?? 0, color: seriesColor(s.key, si) }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value);
    const total = rows.reduce((n, r) => n + r.value, 0);
    return (
      <div>
        <div className="font-medium text-text-primary">{formatDateKey(id)}</div>
        <div className="mt-0.5 tabular-nums">{t("usage.tokens", { value: formatZh(total) })}</div>
        {rows.map((r) => (
          <div key={r.key} className="mt-1 flex items-center gap-1.5">
            <ChartDot color={r.color} />
            <span className="min-w-0 flex-1 truncate">{r.label}</span>
            <span className="shrink-0 text-text-primary tabular-nums">{formatZh(r.value)}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="relative" ref={tip.containerRef} {...tip.handlers}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={t("usage.barChart")}
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
              fontSize={11}
              fill="var(--color-text-tertiary)"
            >
              {formatZh(Math.round(t))}
            </text>
          </g>
        ))}

        {/* 高亮日的竖向底色：其余日变暗时，这一列才不会跟着消失 */}
        {activeIdx >= 0 && (
          <rect
            x={padL + activeIdx * step}
            y={padT}
            width={step}
            height={plotH}
            rx={Math.min(4, step / 3)}
            fill="var(--color-text-primary)"
            opacity={0.07}
            data-testid="usage-bar-cursor"
          />
        )}

        {/* X 轴日期标签（按需抽稀，100 天窗口也不糊） */}
        {dates.map((d, i) =>
          i % labelStep === 0 || i === dates.length - 1 ? (
            <text
              key={d}
              x={xAt(i) + barW / 2}
              y={H - 8}
              textAnchor="middle"
              fontSize={11}
              fill="var(--color-text-tertiary)"
            >
              {formatDateKey(d, false)}
            </text>
          ) : null,
        )}

        {/* 每日堆叠柱：自下而上按序列顺序堆各模型；高亮日以外整体变暗（仍可见当日对比） */}
        {hasData &&
          dates.map((d, i) => {
            const values = series.map((s) => s.values[i] ?? 0);
            const spans = stackSegments(values);
            return (
              <g
                key={d}
                className="transition-opacity duration-150"
                style={{ opacity: activeIdx >= 0 && activeIdx !== i ? 0.32 : 1 }}
              >
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

        {/* 每日悬浮/点击命中区：容器统一处理事件，这里只标 data-tip-id */}
        {hasData &&
          dates.map((d, i) => (
            <rect
              key={`hit-${d}`}
              x={padL + i * step}
              y={padT}
              width={step}
              height={plotH}
              fill="transparent"
              className="cursor-pointer"
              data-tip-id={d}
              data-testid="usage-bar-hit"
              data-date={d}
            />
          ))}

        {!hasData && (
          <text
            x={W / 2}
            y={H / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={13}
            fill="var(--color-text-tertiary)"
          >
            {t("usage.noRangeData")}
          </text>
        )}
      </svg>

      {tip.render(bodyOf)}

      {/* 多序列时给图例（色点与环形图/柱内分段同源色号） */}
      {series.length > 1 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 px-2">
          {series.map((s, i) => (
            <span key={s.key} className="flex items-center gap-1.5 text-[12px] text-text-secondary">
              <span className="h-2 w-2 rounded-[2px]" style={{ background: seriesColor(s.key, i) }} />
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

function Heatmap({ totals }: { totals: Map<string, number> }) {
  const { t } = useTranslation("settings");
  const tip = useChartTip();
  const locale = getLocale();
  const slots = useMemo(() => buildHeatGrid(totals, HEAT_WEEKS, locale), [totals, locale]);
  const weekdayLabels = [1, 2, 3, 4, 5, 6, 0].map((day, index) =>
    index < 5 && index % 2 === 0
      ? new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(2024, 0, 7 + day))
      : "",
  );
  return (
    <div className="relative w-full" ref={tip.containerRef} {...tip.handlers}>
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
        {weekdayLabels.map((label, r) => (
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
              className={`aspect-square w-full rounded-[2px] transition-transform duration-100 ${
                slot.future ? "bg-transparent" : HEAT_LEVEL_CLASSES[slot.level]
              } ${
                !slot.future && slot.date === tip.activeId
                  ? "relative z-10 scale-[1.18] ring-2 ring-text-primary/70"
                  : ""
              } ${slot.future ? "" : "cursor-pointer"}`}
              // 未来的格子不可交互（没有用量）；其余给出 id，容器统一处理悬浮/点击
              data-tip-id={slot.future ? undefined : slot.date}
              data-testid={slot.future ? undefined : "usage-heat-cell"}
              data-date={slot.future ? undefined : slot.date}
            />
          ),
        )}
      </div>
      {tip.render((id) => {
        const tokens = totals.get(id) ?? 0;
        return (
          <div>
            <div className="font-medium text-text-primary">{formatDateKey(id)}</div>
            <div className="mt-0.5 tabular-nums">
              {tokens > 0 ? t("usage.tokens", { value: formatZh(tokens) }) : t("usage.noUsage")}
            </div>
          </div>
        );
      })}
    </div>
  );
}
