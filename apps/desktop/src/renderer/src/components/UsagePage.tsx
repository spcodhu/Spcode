import type { UsageAggregate } from "@spcode/shared";
import { getLocale } from "@spcode/shared/i18n";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { chartVar, donutSegments, formatShare, modelColorIndex, shortModelName, tokensOf } from "../chart";
import { formatZh } from "../format";
import { ChartDot, useChartTip } from "./ChartTip";
import { Icon } from "./Icon";
import { type DailyUsage, UsageTrends } from "./UsageTrends";

type Range = "today" | "week" | "all";

interface Aggregate {
  total: UsageAggregate;
  byModel: Record<string, UsageAggregate>;
}

const RANGE_LABELS: { id: Range; label: `usage.${Range}` }[] = [
  { id: "today", label: "usage.today" },
  { id: "week", label: "usage.week" },
  { id: "all", label: "usage.all" },
];

export function UsagePage() {
  const { t } = useTranslation("settings");
  const [range, setRange] = useState<Range>("week");
  const [data, setData] = useState<Aggregate | null>(null);
  /** 按日×模型明细：趋势曲线与热点图用（拉宽到 1000 个活跃日，覆盖 100 天窗口与历史打卡统计） */
  const [summary, setSummary] = useState<DailyUsage[]>([]);

  useEffect(() => {
    void window.spcode
      .usageAggregate(range)
      .then((d) => setData(d))
      .catch(() => setData(null));
  }, [range]);

  useEffect(() => {
    void window.spcode
      .usageSummary(1000)
      .then((d) => setSummary(d))
      .catch(() => setSummary([]));
  }, []);

  const models = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.byModel)
      .map(([model, u]) => ({ model, ...u, tokens: tokensOf(u) }))
      .sort((a, b) => b.tokens - a.tokens);
  }, [data]);

  /**
   * 模型 → 色号：按全量用量（summary 覆盖 1000 个活跃日）排名分配，
   * 这样切「今日/近7天/累计」或改模型筛选时颜色不会跳变，
   * 环形图、图例、柱状图三处也必然同色。
   */
  const colorIndexOf = useMemo(() => {
    const totals = new Map<string, number>();
    for (const day of summary) {
      for (const [key, agg] of Object.entries(day.byModel)) {
        totals.set(key, (totals.get(key) ?? 0) + tokensOf(agg));
      }
    }
    // summary 还没回来时先用当前区间填上，避免首帧无色
    for (const m of models) if (!totals.has(m.model)) totals.set(m.model, m.tokens);
    return modelColorIndex(totals);
  }, [summary, models]);

  const colorOf = (model: string, fallback: number) => chartVar(colorIndexOf.get(model) ?? fallback);

  const total = data?.total;
  const totalTokens = total ? tokensOf(total) : 0;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold text-text-primary">{t("nav.usage")}</h1>
          <p className="mt-1 text-[13px] text-text-tertiary">{t("usage.description")}</p>
        </div>
        {/* 区间切换 */}
        <div className="flex rounded-full bg-bg-elevated p-1">
          {RANGE_LABELS.map((r) => (
            <button
              type="button"
              key={r.id}
              onClick={() => setRange(r.id)}
              className={`rounded-full px-4 py-1.5 text-[13px] transition-colors ${
                range === r.id ? "bg-accent text-white" : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {t(r.label)}
            </button>
          ))}
        </div>
      </div>

      {/* 区间没用量的日子（比如今天还没开工）也要保留原始结构：
          饼图空环 + 指标卡归零 + 图例区换成一句说明，切区间时页面不会整个塌掉 */}
      <div className="mt-6 flex flex-wrap gap-5" data-testid="usage-overview">
        {/* 左：环形图 + 全模型图例（悬浮/点击联动高亮） */}
        <DonutCard models={models} totalTokens={totalTokens} colorOf={colorOf} />

        {/* 右：统计卡（无数据时显示 0，结构照旧） */}
        <div className="flex min-w-[200px] flex-1 flex-col gap-4">
          <BigStatCard icon="cpu" value={formatZh(totalTokens)} label={t("usage.totalTokens")} />
          <BigStatCard icon="zap" value={(total?.count ?? 0).toLocaleString(getLocale())} label={t("usage.requests")} />
          <BigStatCard
            icon="arrowUp"
            value={formatZh((total?.input ?? 0) + (total?.cacheWrite ?? 0))}
            label={t("usage.inputTokens")}
            extra={total && total.cacheRead > 0 ? t("usage.cache", { value: formatZh(total.cacheRead) }) : undefined}
          />
          <BigStatCard icon="chart" value={formatZh(total?.output ?? 0)} label={t("usage.outputTokens")} />
        </div>
      </div>

      {/* 趋势柱状图 + 活跃热点图（无数据时也渲染骨架，保留打卡 0 天与空网格） */}
      <UsageTrends summary={summary} colorIndexOf={colorIndexOf} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 左侧卡片：环形图 + 全模型图例（纯 SVG，stroke-dasharray 分段）
// ---------------------------------------------------------------------------

function DonutCard({
  models,
  totalTokens,
  colorOf,
}: {
  models: { model: string; tokens: number; count: number }[];
  totalTokens: number;
  colorOf: (model: string, fallback: number) => string;
}) {
  const { t } = useTranslation("settings");
  const tip = useChartTip();
  const R = 80;
  const C = 2 * Math.PI * R;
  // 每个有量的模型都至少占一小段弧（否则 0.2% 的模型会因弧长为 0 而完全消失）
  const fractions = donutSegments(models.map((m) => m.tokens));
  const activeId = tip.activeId;
  // 中心文案跟随高亮：没悬浮时显示占比最大的模型，悬浮/锁定时显示该模型
  const focused = models.find((m) => m.model === activeId) ?? models[0];

  let cursor = C * 0.25; // 从 6 点方向开始（与原实现视觉一致）
  const arcs = models.map((seg, i) => {
    const len = (fractions[i] ?? 0) * C;
    // 段间留缝只在弧足够长时才减，避免小扇区被缝隙吃掉
    const draw = Math.max(0.75, len > 8 ? len - 3 : len);
    const arc = { seg, i, dash: `${draw} ${C - draw}`, offset: -cursor };
    cursor += len;
    return arc;
  });
  // 高亮的弧最后画：叠加时压在其他弧上面，不会被相邻小扇区盖住
  const ordered = [...arcs].sort((a, b) => Number(a.seg.model === activeId) - Number(b.seg.model === activeId));

  return (
    <div
      ref={tip.containerRef}
      className="relative w-full min-w-0 max-w-[380px] shrink-0 rounded-2xl border border-border bg-bg-elevated p-6"
      data-testid="usage-donut-card"
      {...tip.handlers}
    >
      <div className="flex justify-center">
        <svg width="220" height="220" viewBox="0 0 220 220" role="img" aria-label={t("usage.donut")}>
          <circle cx="110" cy="110" r={R} fill="none" stroke="var(--color-bg-hover)" strokeWidth="26" />
          {ordered.map(({ seg, i, dash, offset: o }) => {
            // 占比为 0 的模型不画弧（图例仍保留该行，显示 0%）
            if (fractions[i] === 0) return null;
            const active = seg.model === activeId;
            const dim = !!activeId && !active;
            return (
              <circle
                key={seg.model}
                cx="110"
                cy="110"
                r={R}
                fill="none"
                stroke={colorOf(seg.model, i)}
                strokeWidth={active ? 30 : 26}
                strokeDasharray={dash}
                strokeDashoffset={o}
                strokeLinecap="butt"
                className="cursor-pointer transition-[opacity,stroke-width] duration-150"
                style={{ opacity: dim ? 0.28 : 1 }}
                data-tip-id={seg.model}
                data-testid="usage-donut-arc"
                data-model={seg.model}
              />
            );
          })}
          <text
            x="110"
            y="110"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize="30"
            fontWeight="600"
            fill={focused ? colorOf(focused.model, 0) : "var(--color-text-tertiary)"}
          >
            {focused ? formatShare(focused.tokens, totalTokens) : "—"}
          </text>
        </svg>
      </div>

      {models.length > 0 ? (
        // 每个模型一行：色点与环形图弧段同源色号；悬浮/点击与饼图联动高亮。
        // 用 data-tip-hl 而不是 data-tip-id：图例行本身已有全部数字，再弹卡片会盖住相邻行。
        <div className="mt-6 max-h-64 space-y-1 overflow-y-auto pr-1">
          {models.map((m, i) => (
            <div
              key={m.model}
              data-tip-hl={m.model}
              data-testid="usage-legend-row"
              data-model={m.model}
              className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-[13px] transition-colors ${
                m.model === activeId ? "bg-bg-hover" : ""
              }`}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                style={{ background: colorOf(m.model, i) }}
                data-testid="usage-legend-color"
              />
              <span className="min-w-0 flex-1 truncate font-medium text-text-primary" title={m.model}>
                {shortModelName(m.model)}
              </span>
              <span className="shrink-0 text-text-tertiary">{t("usage.count", { count: m.count })}</span>
              <span className="shrink-0 text-text-primary">{formatZh(m.tokens)}</span>
              <span className="w-10 shrink-0 text-right text-text-tertiary">{formatShare(m.tokens, totalTokens)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-6 rounded-xl border border-dashed border-border px-4 py-6 text-center text-[12px] leading-5 text-text-tertiary">
          {t("usage.noRecords")}
        </div>
      )}

      {tip.render((id) => {
        const i = models.findIndex((m) => m.model === id);
        const m = models[i];
        if (!m) return null;
        return (
          <div>
            <div className="truncate font-medium text-text-primary">{shortModelName(m.model)}</div>
            <div className="mt-1 flex items-center gap-1.5">
              <ChartDot color={colorOf(m.model, i)} />
              <span className="text-text-primary tabular-nums">{formatZh(m.tokens)}</span>
              <span className="text-text-tertiary">
                {t("usage.tokensWithScope", { scope: formatShare(m.tokens, totalTokens) })}
              </span>
            </div>
            <div className="text-text-tertiary">{t("usage.requestCount", { count: m.count })}</div>
          </div>
        );
      })}
    </div>
  );
}

function BigStatCard({ icon, value, label, extra }: { icon: string; value: string; label: string; extra?: string }) {
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-border bg-bg-elevated px-5 py-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg-hover text-text-tertiary">
        <Icon name={icon} size={18} />
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-[26px] font-semibold leading-8 text-text-primary">{value}</span>
          {extra && <span className="text-[12px] text-text-tertiary">{extra}</span>}
        </div>
        <div className="mt-0.5 text-[12px] text-text-tertiary">{label}</div>
      </div>
    </div>
  );
}
