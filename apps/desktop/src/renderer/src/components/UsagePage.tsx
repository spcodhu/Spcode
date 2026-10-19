import type { UsageAggregate } from "@spcode/shared";
import { useEffect, useMemo, useState } from "react";
import { chartVar, donutSegments, formatShare, modelColorIndex, shortModelName, tokensOf } from "../chart";
import { formatZh } from "../format";
import { Icon } from "./Icon";
import { type DailyUsage, UsageTrends } from "./UsageTrends";

type Range = "today" | "week" | "all";

interface Aggregate {
  total: UsageAggregate;
  byModel: Record<string, UsageAggregate>;
}

const RANGE_LABELS: { id: Range; label: string }[] = [
  { id: "today", label: "今日" },
  { id: "week", label: "近 7 天" },
  { id: "all", label: "累计" },
];

export function UsagePage() {
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
  const top = models[0];
  const topShare = top && totalTokens > 0 ? Math.round((top.tokens / totalTokens) * 100) : 0;

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[22px] font-semibold text-text-primary">用量</h1>
          <p className="mt-1 text-[13px] text-text-tertiary">查看 Spcod 本地 token 使用统计和模型订阅额度</p>
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
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {totalTokens === 0 ? (
        <div className="mt-16 text-center text-[13px] text-text-tertiary">
          该区间还没有用量记录，跑几轮对话后这里会有统计。
        </div>
      ) : (
        <div className="mt-6 flex gap-5">
          {/* 左：环形图 + 全模型图例 */}
          <div className="w-[380px] shrink-0 rounded-2xl border border-border bg-bg-elevated p-6">
            <div className="flex justify-center">
              <DonutChart models={models} totalTokens={totalTokens} centerText={`${topShare}%`} colorOf={colorOf} />
            </div>
            {/* 每个模型一行：色点与环形图弧段同源色号，保证颜色一一对应 */}
            <div className="mt-6 max-h-64 space-y-1 overflow-y-auto pr-1">
              {models.map((m, i) => (
                <div key={m.model} className="flex items-center gap-2.5 py-1.5 text-[13px]">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                    style={{ background: colorOf(m.model, i) }}
                    data-testid="usage-legend-color"
                  />
                  <span className="min-w-0 flex-1 truncate font-medium text-text-primary" title={m.model}>
                    {shortModelName(m.model)}
                  </span>
                  <span className="shrink-0 text-text-tertiary">{m.count} 次</span>
                  <span className="shrink-0 text-text-primary">{formatZh(m.tokens)}</span>
                  <span className="w-10 shrink-0 text-right text-text-tertiary">
                    {formatShare(m.tokens, totalTokens)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* 右：统计卡 */}
          <div className="flex flex-1 flex-col gap-4">
            <BigStatCard icon="cpu" value={formatZh(totalTokens)} label="总 Token" />
            <BigStatCard icon="zap" value={(total?.count ?? 0).toLocaleString()} label="请求次数" />
            <BigStatCard
              icon="arrowUp"
              value={formatZh((total?.input ?? 0) + (total?.cacheWrite ?? 0))}
              label="输入 Token"
              extra={total && total.cacheRead > 0 ? `缓存 ${formatZh(total.cacheRead)}` : undefined}
            />
            <BigStatCard icon="chart" value={formatZh(total?.output ?? 0)} label="输出 Token" />
          </div>
        </div>
      )}

      {/* 趋势柱状图 + 活跃热点图（无数据时也渲染骨架，保留打卡 0 天与空网格） */}
      <UsageTrends summary={summary} colorIndexOf={colorIndexOf} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 环形图（纯 SVG，stroke-dasharray 分段）
// ---------------------------------------------------------------------------

function DonutChart({
  models,
  totalTokens,
  centerText,
  colorOf,
}: {
  models: { model: string; tokens: number }[];
  totalTokens: number;
  centerText: string;
  colorOf: (model: string, fallback: number) => string;
}) {
  const R = 80;
  const C = 2 * Math.PI * R;
  // 每个有量的模型都至少占一小段弧（否则 0.2% 的模型会因弧长为 0 而完全消失）
  const fractions = donutSegments(models.map((m) => m.tokens));

  let cursor = C * 0.25; // 从 6 点方向开始（与原实现视觉一致）
  const arcs = models.map((seg, i) => {
    const len = (fractions[i] ?? 0) * C;
    // 段间留缝只在弧足够长时才减，避免小扇区被缝隙吃掉
    const draw = Math.max(0.75, len > 8 ? len - 3 : len);
    const arc = { seg, i, dash: `${draw} ${C - draw}`, offset: -cursor };
    cursor += len;
    return arc;
  });

  return (
    <svg width="220" height="220" viewBox="0 0 220 220" role="img" aria-label="按模型的用量占比环图">
      <circle cx="110" cy="110" r={R} fill="none" stroke="var(--color-bg-hover)" strokeWidth="26" />
      {arcs.map(({ seg, i, dash, offset: o }) =>
        // 占比为 0 的模型不画弧（图例仍保留该行，显示 0%）
        fractions[i] === 0 ? null : (
          <circle
            key={seg.model}
            cx="110"
            cy="110"
            r={R}
            fill="none"
            stroke={colorOf(seg.model, i)}
            strokeWidth="26"
            strokeDasharray={dash}
            strokeDashoffset={o}
            strokeLinecap="butt"
            data-testid="usage-donut-arc"
            data-model={seg.model}
          />
        ),
      )}
      <text
        x="110"
        y="110"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="30"
        fontWeight="600"
        fill={models[0] ? colorOf(models[0].model, 0) : "var(--color-text-primary)"}
      >
        {centerText}
      </text>
    </svg>
  );
}

function BigStatCard({ icon, value, label, extra }: { icon: string; value: string; label: string; extra?: string }) {
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-border bg-bg-elevated px-5 py-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg-hover text-text-tertiary">
        <Icon name={icon} size={18} />
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-[26px] font-semibold leading-8 text-text-primary">{value}</span>
          {extra && <span className="text-[12px] text-text-tertiary">{extra}</span>}
        </div>
        <div className="mt-0.5 text-[12px] text-text-tertiary">{label}</div>
      </div>
    </div>
  );
}
