import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { Switch } from "./ui/Switch";

interface CatalogModel {
  provider: string;
  modelId: string;
  displayName: string;
  reasoning: boolean;
}

interface CatalogProvider {
  provider: string;
  name: string;
  configured: boolean;
  models: CatalogModel[];
}

export function ModelsPage() {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const refreshModels = useStore((s) => s.refreshModels);
  const [catalog, setCatalog] = useState<CatalogProvider[]>([]);
  const [detail, setDetail] = useState<string | null>(null);

  const reload = useCallback(() => {
    void window.spcode
      .command<CatalogProvider[]>({ type: "models.catalog" })
      .then((c) => setCatalog(c ?? []))
      .catch(() => setCatalog([]));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const disabledProviders = useMemo(() => new Set(settings?.disabledProviders ?? []), [settings]);
  const disabledModels = useMemo(() => new Set(settings?.disabledModels ?? []), [settings]);

  const toggleProvider = (id: string, enable: boolean) => {
    const next = new Set(disabledProviders);
    if (enable) next.delete(id);
    else next.add(id);
    void saveSettings({ disabledProviders: [...next] });
  };

  const toggleModel = (key: string, enable: boolean) => {
    const next = new Set(disabledModels);
    if (enable) next.delete(key);
    else next.add(key);
    void saveSettings({ disabledModels: [...next] });
  };

  const enabledCount = (p: CatalogProvider) =>
    p.models.filter((m) => !disabledModels.has(`${m.provider}/${m.modelId}`)).length;

  const detailProvider = detail ? catalog.find((c) => c.provider === detail) : null;

  return (
    <div>
      {detailProvider ? (
        <ProviderDetail
          provider={detailProvider}
          disabledModels={disabledModels}
          onToggleModel={toggleModel}
          onBack={() => setDetail(null)}
          onKeySaved={() => {
            reload();
            void refreshModels();
          }}
        />
      ) : (
        <>
          <PageHeader title="模型" subtitle="配置模型提供商和可用模型，启用或禁用单个模型" />

          <GroupTitle>已配置密钥</GroupTitle>
          <div className="space-y-2">
            {catalog.filter((p) => p.configured).length === 0 && (
              <div className="text-[12px] text-text-tertiary">还没有配置密钥的供应商，从下方选一个填入 API Key。</div>
            )}
            {catalog
              .filter((p) => p.configured)
              .map((p) => (
                <ProviderRow
                  key={p.provider}
                  provider={p}
                  enabled={!disabledProviders.has(p.provider)}
                  enabledCount={enabledCount(p)}
                  onToggle={(v) => toggleProvider(p.provider, v)}
                  onOpen={() => setDetail(p.provider)}
                />
              ))}
          </div>

          <GroupTitle>未配置密钥</GroupTitle>
          <div className="space-y-2">
            {catalog
              .filter((p) => !p.configured)
              .map((p) => (
                <ProviderRow
                  key={p.provider}
                  provider={p}
                  // 未配置密钥的厂商默认关闭，保存密钥后自动开启
                  enabled={false}
                  enabledCount={0}
                  onToggle={(v) => toggleProvider(p.provider, v)}
                  onOpen={() => setDetail(p.provider)}
                />
              ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 供应商行（grip 图标 + 名称 + 已启用 N 个模型 + 开关 + chevron）
// ---------------------------------------------------------------------------

function ProviderRow({
  provider,
  enabled,
  enabledCount,
  onToggle,
  onOpen,
}: {
  provider: CatalogProvider;
  enabled: boolean;
  enabledCount: number;
  onToggle: (v: boolean) => void;
  onOpen: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-elevated px-4 py-3">
      <span className="text-text-tertiary" aria-hidden>
        ⠿
      </span>
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 truncate text-left text-[14px] text-text-primary"
      >
        {provider.name}
      </button>
      {enabled && provider.configured && (
        <span className="shrink-0 text-[12px] text-text-tertiary">已启用 {enabledCount} 个模型</span>
      )}
      {provider.configured ? (
        <Switch on={enabled} onChange={onToggle} label={`${provider.name} 启用`} />
      ) : (
        // 未配置密钥的厂商没有可启停的东西：保存密钥后自动出现可用模型
        <span className="shrink-0 text-[12px] text-text-tertiary">未配置密钥</span>
      )}
      <button type="button" onClick={onOpen} className="shrink-0 text-text-tertiary hover:text-text-secondary">
        <Icon name="chevronRight" size={15} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 供应商详情：API Key + 模型逐个启停
// ---------------------------------------------------------------------------

function ProviderDetail({
  provider,
  disabledModels,
  onToggleModel,
  onBack,
  onKeySaved,
}: {
  provider: CatalogProvider;
  disabledModels: Set<string>;
  onToggleModel: (key: string, enable: boolean) => void;
  onBack: () => void;
  onKeySaved: () => void;
}) {
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(false);

  const saveKey = async () => {
    const k = key.trim();
    if (!k) return;
    await window.spcode.command({ type: "auth.setApiKey", payload: { provider: provider.provider, apiKey: k } });
    setKey("");
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    onKeySaved();
  };

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 flex items-center gap-1.5 text-[13px] text-text-tertiary hover:text-text-primary"
      >
        <Icon name="chevronRight" size={13} style={{ transform: "rotate(180deg)" }} />
        返回
      </button>
      <h1 className="text-[22px] font-semibold text-text-primary">{provider.name}</h1>
      <p className="mt-1 text-[13px] text-text-tertiary">API Key 与可用模型</p>

      <div className="mt-5 flex items-center gap-2 rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <Icon name="key" size={15} className="shrink-0 text-text-tertiary" />
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={provider.configured ? "已保存密钥（输入以更换）" : "sk-..."}
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-text-tertiary"
        />
        <button
          type="button"
          onClick={() => void saveKey()}
          disabled={!key.trim()}
          className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-[12px] text-white hover:bg-accent-dim disabled:opacity-40"
        >
          {saved ? "已保存 ✓" : "保存"}
        </button>
      </div>

      <div className="mb-2 mt-6 text-[13px] font-semibold text-text-secondary">
        可用模型（{provider.models.length}）
      </div>
      <div className="space-y-1.5">
        {provider.models.length === 0 && <div className="text-[12px] text-text-tertiary">该供应商暂无目录内模型。</div>}
        {provider.models.map((m) => {
          const k = `${m.provider}/${m.modelId}`;
          const enabled = !disabledModels.has(k);
          return (
            <div key={k} className="flex items-center gap-3 rounded-xl border border-border bg-bg-elevated px-4 py-2.5">
              <Icon name="cpu" size={14} className="shrink-0 text-text-tertiary" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">{m.displayName}</span>
              {m.reasoning && (
                <span className="shrink-0 rounded-full bg-thinking/15 px-2 py-0.5 text-[11px] text-thinking">推理</span>
              )}
              <Switch on={enabled} onChange={(v) => onToggleModel(k, v)} label={`${m.displayName} 启用`} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-[22px] font-semibold text-text-primary">{title}</h1>
      <p className="mt-1 text-[13px] text-text-tertiary">{subtitle}</p>
    </div>
  );
}

function GroupTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 mt-6 text-[13px] font-semibold text-text-secondary first:mt-0">{children}</h2>;
}
