import type { QuotaInfo, QuotaLimit } from "@spcode/shared";
import { useEffect, useState } from "react";
import { formatTime } from "../format";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { Switch } from "./ui/Switch";

export function QuotaPage() {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const [quotas, setQuotas] = useState<QuotaInfo[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = (force = false) => {
    setLoading(true);
    void window.spcode
      .quotaQuery(force)
      .then((q) => setQuotas((q ?? []) as QuotaInfo[]))
      .catch(() => setQuotas([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[22px] font-semibold text-text-primary">配额</h1>
          <p className="mt-1 text-[13px] text-text-tertiary">当前模型供应商的订阅额度与余额</p>
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading}
          className="mt-1 flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12.5px] text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary disabled:opacity-50"
        >
          <Icon name="refresh" size={13} className={loading ? "animate-spin" : ""} />
          {loading ? "查询中…" : "刷新"}
        </button>
      </div>

      {/* 快捷展示开关 */}
      <div className="mt-6 flex items-center justify-between border-b border-border pb-5">
        <div>
          <div className="text-[15px] font-medium text-text-primary">上下文用量环</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">在输入框旁显示当前会话的上下文占用，悬浮查看明细</div>
        </div>
        <Switch
          on={settings?.quickQuota ?? true}
          onChange={(v) => void saveSettings({ quickQuota: v })}
          label="上下文用量环"
        />
      </div>

      <div className="mb-2 mt-4" />

      {(quotas ?? []).map((q) => (
        <ProviderSection key={q.provider} info={q} />
      ))}
    </div>
  );
}

function ProviderSection({ info }: { info: QuotaInfo }) {
  return (
    <section className="border-b border-border py-5 last:border-b-0">
      <div className="mb-1 flex items-baseline justify-between">
        <div>
          <h2 className="text-[17px] font-semibold text-text-primary">{info.label}</h2>
          <div className="mt-0.5 text-[12px] text-text-tertiary">
            {!info.configured ? "未配置密钥" : (info.plan ?? "订阅额度")}
          </div>
        </div>
      </div>

      {info.error ? (
        <div className="mt-3 text-[13px] text-warning" title={info.error}>
          查询失败：{info.error}
        </div>
      ) : !info.configured ? null : (
        <div className="mt-3 space-y-3">
          {info.limits.map((l) => (
            <LimitRow key={l.label} limit={l} />
          ))}
        </div>
      )}

      {info.configured && !info.error && (
        <div className="mt-3 text-right text-[11px] text-text-tertiary">更新于 {formatTime(info.updatedAt)}</div>
      )}
    </section>
  );
}

/**
 * 单行额度：进度条表示已消耗占比，右侧同时标出「剩余 / 已用」两个口径，
 * 避免只剩一个数字时分不清是余量还是消耗量。
 * usedPercent 非有限值（上游缺字段/脏数据）一律降级为文字行——绝不渲染 NaN。
 */
function LimitRow({ limit: l }: { limit: QuotaLimit }) {
  if (l.usedPercent == null || !Number.isFinite(l.usedPercent)) {
    return (
      <div className="flex items-center gap-4">
        <span className="w-20 shrink-0 text-[13px] text-text-secondary">{l.label}</span>
        <span className="text-[13px] text-text-primary">{l.text ?? "—"}</span>
        {l.resetText && <span className="shrink-0 text-[12px] text-text-tertiary">{l.resetText}</span>}
      </div>
    );
  }
  const usedPct = Math.round(Math.min(100, Math.max(0, l.usedPercent)));
  const remainPct = 100 - usedPct;
  return (
    <div className="flex items-center gap-4">
      <span className="w-20 shrink-0 text-[13px] text-text-secondary">{l.label}</span>
      <div
        className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-hover"
        title={`已用 ${usedPct}% · 剩余 ${remainPct}%`}
      >
        <div
          className={`h-full rounded-full transition-all ${usedPct > 85 ? "bg-danger" : "bg-accent"}`}
          style={{ width: `${usedPct}%` }}
        />
      </div>
      <span className="shrink-0 text-[13px] font-semibold text-text-primary">剩余 {remainPct}%</span>
      <span className="shrink-0 text-[12px] text-text-tertiary">已用 {usedPct}%</span>
      {l.resetText && (
        <span className="shrink-0 text-[12px] text-text-tertiary" title="额度重置时间">
          {l.resetText}
        </span>
      )}
    </div>
  );
}
