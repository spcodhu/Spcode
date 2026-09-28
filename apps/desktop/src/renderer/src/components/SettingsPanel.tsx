import { useEffect, useState } from "react";
import { useStore } from "../store";

interface ProviderInfo {
  id: string;
  name: string;
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const refreshModels = useStore((s) => s.refreshModels);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [savedHint, setSavedHint] = useState<string | null>(null);

  useEffect(() => {
    void window.spcode
      .command<ProviderInfo[]>({ type: "auth.listProviders" })
      .then((list) => setProviders(list ?? []))
      .catch(() => setProviders([]));
  }, []);

  const saveKey = async (provider: string) => {
    const key = apiKeys[provider]?.trim();
    if (!key) return;
    await window.spcode.command({ type: "auth.setApiKey", payload: { provider, apiKey: key } });
    setApiKeys((m) => ({ ...m, [provider]: "" }));
    setSavedHint(provider);
    setTimeout(() => setSavedHint(null), 2000);
    await refreshModels();
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="max-h-[85vh] w-[560px] overflow-y-auto rounded-xl border border-border bg-bg-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">设置</h2>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            ✕
          </button>
        </div>

        <div className="space-y-6 px-5 py-4">
          {/* API Key */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              模型供应商 API Key
            </h3>
            <p className="mb-3 text-xs text-text-tertiary">
              填入后自动可用该厂商全部模型。密钥存储在本地 ~/.spcode/agent/auth.json。
            </p>
            <div className="space-y-2">
              {providers.map((p) => (
                <div key={p.id} className="flex items-center gap-2">
                  <span className="w-36 shrink-0 truncate text-xs text-text-secondary" title={p.id}>
                    {p.name}
                  </span>
                  <input
                    type="password"
                    value={apiKeys[p.id] ?? ""}
                    onChange={(e) => setApiKeys((m) => ({ ...m, [p.id]: e.target.value }))}
                    placeholder="sk-..."
                    className="min-w-0 flex-1 rounded-md border border-border bg-bg-main px-2 py-1.5 text-xs outline-none focus:border-accent/50"
                  />
                  <button
                    onClick={() => void saveKey(p.id)}
                    disabled={!apiKeys[p.id]?.trim()}
                    className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs text-bg-root hover:bg-accent-dim disabled:opacity-40"
                  >
                    {savedHint === p.id ? "已保存 ✓" : "保存"}
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* 默认思考强度 */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              默认思考强度
            </h3>
            <select
              value={settings?.defaultThinkingLevel ?? "medium"}
              onChange={(e) => void saveSettings({ defaultThinkingLevel: e.target.value })}
              className="rounded-md border border-border bg-bg-main px-2 py-1.5 text-xs outline-none"
            >
              {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((lv) => (
                <option key={lv} value={lv}>
                  {lv}
                </option>
              ))}
            </select>
          </section>

          {/* 权限模式 */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              权限模式
            </h3>
            <div className="flex gap-2">
              {(
                [
                  { id: "ask", label: "🛡 询问模式", desc: "写操作/Shell 每次确认" },
                  { id: "act", label: "⚡ 行动模式", desc: "仅危险命令确认" },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  onClick={() => void saveSettings({ permissionMode: m.id })}
                  className={`flex-1 rounded-md border px-3 py-2 text-left text-xs ${
                    settings?.permissionMode === m.id
                      ? "border-accent/50 bg-accent-soft text-accent"
                      : "border-border text-text-secondary hover:bg-bg-hover"
                  }`}
                >
                  <div className="font-medium">{m.label}</div>
                  <div className="mt-0.5 text-text-tertiary">{m.desc}</div>
                </button>
              ))}
            </div>
          </section>

          {/* 厂商配额 */}
          <QuotaSection />

          {/* Token 用量统计 */}
          <UsageSection />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 厂商配额卡片
// ---------------------------------------------------------------------------

interface QuotaInfo {
  provider: string;
  label: string;
  configured: boolean;
  remaining: string | null;
  total?: string | null;
  usedPercent?: number | null;
  plan?: string | null;
  error?: string;
}

function QuotaSection() {
  const [quotas, setQuotas] = useState<QuotaInfo[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    void window.spcode
      .quotaQuery()
      .then((q) => setQuotas(q ?? []))
      .catch(() => setQuotas([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">厂商配额</h3>
        <button onClick={load} className="text-xs text-text-tertiary hover:text-accent">
          {loading ? "查询中…" : "刷新"}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {(quotas ?? []).map((q) => (
          <div key={q.provider} className="rounded-lg border border-border bg-bg-main px-3 py-2">
            <div className="text-xs text-text-secondary">{q.label}</div>
            <div className="mt-1 text-sm font-semibold text-text-primary">
              {!q.configured ? (
                <span className="text-text-tertiary">未配置密钥</span>
              ) : q.error ? (
                <span className="text-warning" title={q.error}>查询失败</span>
              ) : (
                (q.remaining ?? <span className="text-text-tertiary">—</span>)
              )}
            </div>
            {q.usedPercent != null && (
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-bg-hover">
                <div
                  className={`h-full rounded-full ${q.usedPercent > 85 ? "bg-danger" : "bg-accent"}`}
                  style={{ width: `${Math.min(100, q.usedPercent)}%` }}
                />
              </div>
            )}
            {q.plan && <div className="mt-1 text-xs text-text-tertiary">{q.plan}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Token 用量统计
// ---------------------------------------------------------------------------

interface DailyUsage {
  date: string;
  total: {
    input: number;
    output: number;
    cacheRead: number;
    costTotal: number;
    count: number;
  };
  byModel: Record<string, { input: number; output: number; cacheRead: number; costTotal: number; count: number }>;
}

function UsageSection() {
  const [days, setDays] = useState<DailyUsage[] | null>(null);

  useEffect(() => {
    void window.spcode
      .usageSummary(7)
      .then((d) => setDays(d ?? []))
      .catch(() => setDays([]));
  }, []);

  const hasData = days?.some((d) => d.total.count > 0);

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
        Token 用量（近 7 天）
      </h3>
      {!hasData ? (
        <div className="text-xs text-text-tertiary">还没有用量记录，跑几轮对话后这里会有统计。</div>
      ) : (
        <div className="space-y-2">
          {days
            ?.filter((d) => d.total.count > 0)
            .map((d) => {
              const cacheRate =
                d.total.input > 0 ? Math.round((d.total.cacheRead / (d.total.input + d.total.cacheRead)) * 100) : 0;
              return (
                <div key={d.date} className="rounded-lg border border-border bg-bg-main px-3 py-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-text-secondary">{d.date}</span>
                    <span className="text-text-tertiary">
                      {formatTok(d.total.input + d.total.output)} tok · 缓存 {cacheRate}% · $
                      {d.total.costTotal.toFixed(4)}
                    </span>
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {Object.entries(d.byModel).map(([model, u]) => (
                      <div key={model} className="flex items-center justify-between text-xs text-text-tertiary">
                        <span className="truncate">{model}</span>
                        <span>
                          {formatTok(u.input + u.output)} · ${u.costTotal.toFixed(4)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </section>
  );
}

function formatTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
