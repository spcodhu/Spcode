import type { UsageAggregate } from "@spcode/shared";
import { useEffect, useMemo, useState } from "react";
import { formatZh } from "../format";
import { Icon } from "./Icon";

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

const CHART_COLORS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6"] as const;

/** 色板 CSS 变量引用（样式表 :root 里定义，随主题无关） */
function chartVar(i: number): string {
  return `var(${CHART_COLORS[i % CHART_COLORS.length]})`;
}

export function UsagePage() {
  const [range, setRange] = useState<Range>("week");
  const [data, setData] = useState<Aggregate | null>(null);

  useEffect(() => {
    void window.spcode
      .usageAggregate(range)
      .then((d) => setData(d))
      .catch(() => setData(null));
  }, [range]);

  const models = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.byModel)
      .map(([model, u]) => ({ model, ...u, tokens: u.input + u.output + u.cacheRead + u.cacheWrite }))
      .sort((a, b) => b.tokens - a.tokens);
  }, [data]);

  const total = data?.total;
  const totalTokens = total ? total.input + total.output + total.cacheRead + total.cacheWrite : 0;
  const top = models[0];
  const topShare = top && totalTokens > 0 ? Math.round((top.tokens / totalTokens) * 100) : 0;

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[22px] font-semibold text-text-primary">用量</h1>
          <p className="mt-1 text-[13px] text-text-tertiary">查看 Spcode 本地 token 使用统计和模型订阅额度</p>
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
              <DonutChart models={models} totalTokens={totalTokens} centerText={`${topShare}%`} />
            </div>
            {/* 每个模型一行：色点与环形图弧段同序号，保证颜色一一对应 */}
            <div className="mt-6 space-y-1">
              {models.map((m, i) => (
                <div key={m.model} className="flex items-center gap-2.5 py-1.5 text-[13px]">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: chartVar(i) }} />
                  <span className="min-w-0 flex-1 truncate font-medium text-text-primary" title={m.model}>
                    {shortModelName(m.model)}
                  </span>
                  <span className="shrink-0 text-text-tertiary">{m.count} 次</span>
                  <span className="shrink-0 text-text-primary">{formatZh(m.tokens)}</span>
                  <span className="w-10 shrink-0 text-right text-text-tertiary">
                    {totalTokens > 0 ? `${Math.round((m.tokens / totalTokens) * 100)}%` : "—"}
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
}: {
  models: { model: string; tokens: number }[];
  totalTokens: number;
  centerText: string;
}) {
  const R = 80;
  const C = 2 * Math.PI * R;
  const top = models.slice(0, 5);
  const restTokens = models.slice(5).reduce((n, m) => n + m.tokens, 0);
  const segments = restTokens > 0 ? [...top, { model: "其他", tokens: restTokens }] : top;

  let offset = C * 0.25; // 从 12 点方向开始
  const arcs = segments.map((seg, i) => {
    const frac = totalTokens > 0 ? seg.tokens / totalTokens : 0;
    const len = Math.max(0, frac * C - 3); // 段间留缝
    const arc = { seg, i, dash: `${len} ${C - len}`, offset: -offset };
    offset += frac * C;
    return arc;
  });

  return (
    <svg width="220" height="220" viewBox="0 0 220 220" role="img" aria-label="按模型的用量占比环图">
      <circle cx="110" cy="110" r={R} fill="none" stroke="var(--color-bg-hover)" strokeWidth="26" />
      {arcs.map(({ seg, i, dash, offset: o }) => (
        <circle
          key={seg.model}
          cx="110"
          cy="110"
          r={R}
          fill="none"
          stroke={chartVar(i)}
          strokeWidth="26"
          strokeDasharray={dash}
          strokeDashoffset={o}
          strokeLinecap="butt"
        />
      ))}
      <text
        x="110"
        y="110"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="30"
        fontWeight="600"
        fill="var(--chart-1)"
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

function shortModelName(model: string): string {
  const id = model.split("/").pop() ?? model;
  return id.length > 24 ? `${id.slice(0, 24)}…` : id;
}
