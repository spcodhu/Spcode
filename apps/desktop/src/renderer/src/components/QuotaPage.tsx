import type { QuotaInfo, QuotaLimit } from "@spcode/shared";
import { getLocale } from "@spcode/shared/i18n";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatTime } from "../format";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { Switch } from "./ui/Switch";

export function QuotaPage() {
  const { t } = useTranslation("settings");
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const [quotas, setQuotas] = useState<QuotaInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = (force = false) => {
    setLoading(true);
    setLoadError(null);
    void window.spcode
      .quotaQuery(force)
      .then((q) => setQuotas((q ?? []) as QuotaInfo[]))
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[22px] font-semibold text-text-primary">{t("nav.quota")}</h1>
          <p className="mt-1 text-[13px] text-text-tertiary">{t("quota.description")}</p>
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading}
          className="mt-1 flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12.5px] text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary disabled:opacity-50"
        >
          <Icon name="refresh" size={13} className={loading ? "animate-spin" : ""} />
          {loading ? t("quota.loading") : t("quota.refresh")}
        </button>
      </div>

      {/* 快捷展示开关 */}
      <div className="mt-6 flex items-center justify-between border-b border-border pb-5">
        <div>
          <div className="text-[15px] font-medium text-text-primary">{t("quota.contextRing")}</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">{t("quota.contextRingDescription")}</div>
        </div>
        <Switch
          on={settings?.quickQuota ?? true}
          onChange={(v) => void saveSettings({ quickQuota: v })}
          label={t("quota.contextRing")}
        />
      </div>

      <div className="mb-2 mt-4" />

      {quotas === null && loading ? (
        <div role="status" data-testid="quota-loading" className="py-8 text-center text-[13px] text-text-tertiary">
          {t("quota.loading")}
        </div>
      ) : loadError ? (
        <div
          role="alert"
          data-testid="quota-load-error"
          className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-[13px] text-danger"
        >
          <div>{t("quota.loadFailed", { error: loadError })}</div>
          <button
            type="button"
            data-testid="quota-retry"
            onClick={() => load()}
            className="mt-2 rounded-lg border border-danger/40 px-3 py-1.5 text-[12px] hover:bg-danger/10"
          >
            {t("retry")}
          </button>
        </div>
      ) : quotas?.length === 0 ? (
        <div data-testid="quota-empty" className="py-8 text-center text-[13px] text-text-tertiary">
          {t("quota.empty")}
        </div>
      ) : (
        (quotas ?? []).map((q) => <ProviderSection key={q.provider} info={q} />)
      )}
    </div>
  );
}

function ProviderSection({ info }: { info: QuotaInfo }) {
  const { t } = useTranslation("settings");
  return (
    <section className="border-b border-border py-5 last:border-b-0">
      <div className="mb-1 flex items-baseline justify-between">
        <div>
          <h2 className="text-[17px] font-semibold text-text-primary">{info.label}</h2>
          <div className="mt-0.5 text-[12px] text-text-tertiary">
            {!info.configured ? t("models.unconfigured") : (info.plan ?? t("quota.subscription"))}
          </div>
        </div>
      </div>

      {info.error ? (
        <div className="mt-3 text-[13px] text-warning" title={info.error}>
          {t("quota.error", { error: info.error })}
        </div>
      ) : !info.configured ? null : (
        <div className="mt-3 space-y-3">
          {info.limits.map((l) => (
            <LimitRow key={l.label} limit={l} />
          ))}
        </div>
      )}

      {info.configured && !info.error && (
        <div className="mt-3 text-right text-[11px] text-text-tertiary">
          {t("quota.updated", { time: formatTime(info.updatedAt) })}
        </div>
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
  const { t } = useTranslation("settings");
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
  const formatPercent = (value: number) =>
    new Intl.NumberFormat(getLocale(), { style: "percent", maximumFractionDigits: 0 }).format(value / 100);
  return (
    <div className="flex items-center gap-4">
      <span className="w-20 shrink-0 text-[13px] text-text-secondary">{l.label}</span>
      <div
        className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-hover"
        title={t("quota.percent", { used: formatPercent(usedPct), remaining: formatPercent(remainPct) })}
      >
        <div
          className={`h-full rounded-full transition-all ${usedPct > 85 ? "bg-danger" : "bg-accent"}`}
          style={{ width: `${usedPct}%` }}
        />
      </div>
      <span className="shrink-0 text-[13px] font-semibold text-text-primary">
        {t("quota.remaining", { percent: formatPercent(remainPct) })}
      </span>
      <span className="shrink-0 text-[12px] text-text-tertiary">
        {t("quota.used", { percent: formatPercent(usedPct) })}
      </span>
      {l.resetText && (
        <span className="shrink-0 text-[12px] text-text-tertiary" title={t("quota.resetTime")}>
          {l.resetText}
        </span>
      )}
    </div>
  );
}
