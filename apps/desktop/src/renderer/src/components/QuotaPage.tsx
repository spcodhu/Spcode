import { useEffect, useState } from "react";
import { formatTime } from "../format";
import { useStore } from "../store";
import { Switch } from "./ui/Switch";

interface QuotaLimit {
  label: string;
  usedPercent: number | null;
  text: string | null;
  resetText: string | null;
}

interface QuotaInfo {
  provider: string;
  label: string;
  configured: boolean;
  plan: string | null;
  limits: QuotaLimit[];
  updatedAt: number;
  error?: string;
}

export function QuotaPage() {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const [quotas, setQuotas] = useState<QuotaInfo[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    void window.spcode
      .quotaQuery()
      .then((q) => setQuotas((q ?? []) as QuotaInfo[]))
      .catch(() => setQuotas([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <div>
      <h1 className="text-[22px] font-semibold text-text-primary">配额</h1>
      <p className="mt-1 text-[13px] text-text-tertiary">当前模型供应商的订阅额度与余额</p>

      {/* 快捷展示开关 */}
      <div className="mt-6 flex items-center justify-between border-b border-border pb-5">
        <div>
          <div className="text-[15px] font-medium text-text-primary">快捷展示配额</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">在模型行悬浮时显示配额卡片</div>
        </div>
        <Switch
          on={settings?.quickQuota ?? true}
          onChange={(v) => void saveSettings({ quickQuota: v })}
          label="快捷展示配额"
        />
      </div>

      <div className="mb-2 mt-4 flex justify-end">
        <button onClick={load} className="text-[12px] text-text-tertiary hover:text-accent">
          {loading ? "查询中…" : "刷新"}
        </button>
      </div>

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
          {info.limits.map((l, i) => (
            <div key={i} className="flex items-center gap-4">
              <span className="w-20 shrink-0 text-[13px] text-text-secondary">{l.label}</span>
              {l.usedPercent != null ? (
                <>
                  <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-hover">
                    <div
                      className={`h-full rounded-full transition-all ${l.usedPercent > 85 ? "bg-danger" : "bg-accent"}`}
                      style={{ width: `${Math.min(100, Math.max(0, l.usedPercent))}%` }}
                    />
                  </div>
                  <span className="shrink-0 text-[13px] font-semibold text-text-primary">{l.text ?? "—"}</span>
                </>
              ) : (
                <span className="text-[13px] text-text-primary">{l.text ?? "—"}</span>
              )}
              {l.resetText && <span className="shrink-0 text-[12px] text-text-tertiary">{l.resetText}</span>}
            </div>
          ))}
        </div>
      )}

      {info.configured && !info.error && (
        <div className="mt-3 text-right text-[11px] text-text-tertiary">更新于 {formatTime(info.updatedAt)}</div>
      )}
    </section>
  );
}
