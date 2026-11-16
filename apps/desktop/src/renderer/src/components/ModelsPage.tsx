import type {
  AddCustomModelInput,
  CatalogModel,
  CatalogProvider,
  CustomProviderInput,
  ModelCatalogSyncStatus,
  ModelPriceRates,
  SystemMessageRole,
} from "@spcode/shared";
import { CUSTOM_PROVIDER_APIS, validateCustomProviderInput, validateModelInput } from "@spcode/shared";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { Modal } from "./ui/Modal";
import { Select } from "./ui/Select";
import { Switch } from "./ui/Switch";

export type { CatalogModel, CatalogProvider };

/** 单个供应商的模型列表分页大小（OpenRouter 这类中转站一次能开出几百个模型） */
const MODELS_PAGE_SIZE = 30;

export function ModelsPage() {
  const { t } = useTranslation("settings");
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const refreshModels = useStore((s) => s.refreshModels);
  const [catalog, setCatalog] = useState<CatalogProvider[]>([]);
  const [detail, setDetail] = useState<string | null>(null);
  const [providerEditor, setProviderEditor] = useState<{ provider?: CatalogProvider } | null>(null);
  const [syncStatus, setSyncStatus] = useState<ModelCatalogSyncStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(() => {
    void window.spcode
      .command<CatalogProvider[]>({ type: "models.catalog" })
      .then((c) => setCatalog(c ?? []))
      .catch(() => setCatalog([]));
  }, []);

  useEffect(() => {
    reload();
    void window.spcode
      .command<ModelCatalogSyncStatus>({ type: "models.catalogSyncStatus" })
      .then((s) => setSyncStatus(s ?? null))
      .catch(() => {});
  }, [reload]);

  const refreshCatalog = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await window.spcode.command({ type: "models.refreshCatalog" });
      const s = await window.spcode.command<ModelCatalogSyncStatus>({ type: "models.catalogSyncStatus" });
      setSyncStatus(s ?? null);
      reload();
      void refreshModels();
    } catch {
      // 失败时重拉状态以展示 lastError
      void window.spcode
        .command<ModelCatalogSyncStatus>({ type: "models.catalogSyncStatus" })
        .then((s) => setSyncStatus(s ?? null))
        .catch(() => {});
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, reload, refreshModels]);

  // 目录变化（添加/删除自定义模型）后 Composer 的可用模型列表也要重拉
  const handleChanged = useCallback(() => {
    reload();
    void refreshModels();
  }, [reload, refreshModels]);

  const disabledProviders = useMemo(() => new Set(settings?.disabledProviders ?? []), [settings]);
  const disabledModels = useMemo(() => new Set(settings?.disabledModels ?? []), [settings]);

  const toggleProvider = (id: string, enable: boolean) => {
    void saveSettings((current) => {
      const next = new Set(current?.disabledProviders ?? []);
      if (enable) next.delete(id);
      else next.add(id);
      return { disabledProviders: [...next] };
    });
  };

  const toggleModel = (key: string, enable: boolean) => {
    void saveSettings((current) => {
      const next = new Set(current?.disabledModels ?? []);
      if (enable) next.delete(key);
      else next.add(key);
      return { disabledModels: [...next] };
    });
  };

  const toggleModels = (keys: string[], enable: boolean) => {
    if (keys.length === 0) return;
    void saveSettings((current) => {
      const next = new Set(current?.disabledModels ?? []);
      for (const key of keys) {
        if (enable) next.delete(key);
        else next.add(key);
      }
      return { disabledModels: [...next] };
    });
  };

  const enabledCount = (p: CatalogProvider) =>
    p.models.filter((m) => !disabledModels.has(`${m.provider}/${m.modelId}`)).length;

  const detailProvider = detail ? catalog.find((c) => c.provider === detail) : null;

  const removeProvider = async (provider: CatalogProvider) => {
    const confirmKey = provider.custom ? "models.removeProviderConfirm" : "models.removeConfiguredProviderConfirm";
    if (!window.confirm(t(confirmKey, { name: provider.name }))) return;
    await window.spcode.command({ type: "models.removeProvider", payload: { provider: provider.provider } });
    setDetail(null);
    handleChanged();
  };

  return (
    <div>
      {detailProvider ? (
        <ProviderDetail
          provider={detailProvider}
          disabledModels={disabledModels}
          onToggleModel={toggleModel}
          onToggleModels={toggleModels}
          onBack={() => setDetail(null)}
          onChanged={handleChanged}
          onEdit={() => setProviderEditor({ provider: detailProvider })}
          onRemove={() => void removeProvider(detailProvider)}
        />
      ) : (
        <>
          <PageHeader title={t("nav.models")} subtitle={t("models.description")} />

          <div className="mb-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="models-add-provider"
              onClick={() => setProviderEditor({})}
              className="rounded-lg bg-accent px-3 py-1.5 text-[12px] text-on-accent hover:bg-accent-dim"
            >
              {t("models.addProvider")}
            </button>
            <button
              type="button"
              data-testid="models-refresh-catalog"
              onClick={() => void refreshCatalog()}
              disabled={refreshing}
              className="rounded-lg border border-border bg-bg-elevated px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
            >
              {refreshing ? t("models.refreshCatalogRunning") : t("models.refreshCatalog")}
            </button>
            {syncStatus && (
              <span className="text-[12px] text-text-tertiary">
                {syncStatus.inProgress
                  ? t("models.refreshCatalogRunning")
                  : syncStatus.lastError
                    ? t("models.refreshCatalogError", { error: syncStatus.lastError })
                    : syncStatus.lastSyncedAt
                      ? t("models.refreshCatalogLastSynced", {
                          time: new Date(syncStatus.lastSyncedAt).toLocaleTimeString(),
                        })
                      : t("models.refreshCatalogNever")}
              </span>
            )}
          </div>

          <GroupTitle>{t("models.configured")}</GroupTitle>
          <div className="space-y-2" data-testid="configured-providers">
            {catalog.filter((p) => p.configured).length === 0 && (
              <div className="text-[12px] text-text-tertiary">{t("models.empty")}</div>
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

          <GroupTitle>{t("models.unconfigured")}</GroupTitle>
          <div className="space-y-2" data-testid="unconfigured-providers">
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
      {providerEditor && (
        <ProviderFormModal
          provider={providerEditor.provider}
          onClose={() => setProviderEditor(null)}
          onSaved={(providerId) => {
            setProviderEditor(null);
            setDetail(providerId);
            handleChanged();
          }}
        />
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
  const { t } = useTranslation("settings");
  return (
    <div
      data-testid="provider-row"
      data-provider={provider.provider}
      className="flex items-center gap-3 rounded-xl border border-border bg-bg-elevated px-4 py-3"
    >
      <span className="text-text-tertiary" aria-hidden>
        ⠿
      </span>
      <button
        type="button"
        data-testid="provider-open"
        onClick={onOpen}
        className="min-w-0 flex-1 truncate text-left text-[14px] text-text-primary"
      >
        {provider.name}
      </button>
      {provider.custom && (
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-text-secondary">
          {t("models.sourceCustom")}
        </span>
      )}
      {enabled && provider.configured && (
        <span className="shrink-0 text-[12px] text-text-tertiary">
          {t("models.enabledCount", { count: enabledCount })}
        </span>
      )}
      {provider.configured ? (
        <Switch on={enabled} onChange={onToggle} label={t("enableName", { name: provider.name })} />
      ) : (
        // 未配置密钥的厂商没有可启停的东西：保存密钥后自动出现可用模型
        <span className="shrink-0 text-[12px] text-text-tertiary">{t("models.unconfigured")}</span>
      )}
      <button
        type="button"
        onClick={onOpen}
        aria-label={t("models.openProvider", { name: provider.name })}
        className="shrink-0 text-text-tertiary hover:text-text-secondary"
      >
        <Icon name="chevronRight" size={15} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 供应商详情：API Key + 模型逐个启停 + 添加自定义模型
// ---------------------------------------------------------------------------

function ProviderDetail({
  provider,
  disabledModels,
  onToggleModel,
  onToggleModels,
  onBack,
  onChanged,
  onEdit,
  onRemove,
}: {
  provider: CatalogProvider;
  disabledModels: Set<string>;
  onToggleModel: (key: string, enable: boolean) => void;
  onToggleModels: (keys: string[], enable: boolean) => void;
  onBack: () => void;
  /** 目录变化（存密钥 / 增删模型）后重拉目录与可用模型列表 */
  onChanged: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("settings");
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [pricingFor, setPricingFor] = useState<string | null>(null);
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const saveKey = async () => {
    const k = key.trim();
    if (!k) return;
    await window.spcode.command({ type: "auth.setApiKey", payload: { provider: provider.provider, apiKey: k } });
    setKey("");
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    onChanged();
  };

  const removeModel = async (m: CatalogModel) => {
    if (!window.confirm(t("models.removeConfirm", { name: m.displayName }))) return;
    await window.spcode.command({
      type: "models.removeModel",
      payload: { provider: m.provider, modelId: m.modelId },
    });
    setEditingModel(null);
    onChanged();
  };

  // 先按关键词过滤再分页；搜索输入变化时在 onChange 中同步回第一页，避免停在空页
  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return provider.models;
    return provider.models.filter(
      (m) => m.displayName.toLowerCase().includes(q) || m.modelId.toLowerCase().includes(q),
    );
  }, [provider.models, query]);
  const totalPages = Math.max(1, Math.ceil(filteredModels.length / MODELS_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageModels = filteredModels.slice(
    currentPage * MODELS_PAGE_SIZE,
    currentPage * MODELS_PAGE_SIZE + MODELS_PAGE_SIZE,
  );
  const allModelKeys = useMemo(() => provider.models.map((m) => `${m.provider}/${m.modelId}`), [provider.models]);
  const allEnabled = allModelKeys.length > 0 && allModelKeys.every((key) => !disabledModels.has(key));
  const allDisabled = allModelKeys.length > 0 && allModelKeys.every((key) => disabledModels.has(key));

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 flex items-center gap-1.5 text-[13px] text-text-tertiary hover:text-text-primary"
      >
        <Icon name="chevronRight" size={13} style={{ transform: "rotate(180deg)" }} />
        {t("back")}
      </button>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[22px] font-semibold text-text-primary">{provider.name}</h1>
        {provider.custom && (
          <button
            type="button"
            data-testid="provider-edit"
            onClick={onEdit}
            className="rounded-lg border border-border px-2.5 py-1 text-[12px] text-text-secondary hover:bg-bg-hover"
          >
            {t("models.editProvider")}
          </button>
        )}
        {(provider.custom || provider.configured) && (
          <button
            type="button"
            data-testid="provider-delete"
            onClick={onRemove}
            className="rounded-lg border border-danger/40 px-2.5 py-1 text-[12px] text-danger hover:bg-danger/10"
          >
            {t("models.deleteProvider")}
          </button>
        )}
      </div>
      <p className="mt-1 text-[13px] text-text-tertiary">{t("models.detailDescription")}</p>

      <div className="mt-5 flex items-center gap-2 rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <Icon name="key" size={15} className="shrink-0 text-text-tertiary" />
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={provider.configured ? t("models.keyPlaceholder") : "sk-..."}
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-text-tertiary"
        />
        <button
          type="button"
          onClick={() => void saveKey()}
          disabled={!key.trim()}
          className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-[12px] text-on-accent hover:bg-accent-dim disabled:opacity-40"
        >
          {saved ? t("saved") : t("save")}
        </button>
      </div>

      <div className="mb-2 mt-6 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[13px] font-semibold text-text-secondary">
          {t("models.availableCount", { count: filteredModels.length })}
        </div>
        {allModelKeys.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="models-enable-all"
              disabled={allEnabled}
              aria-label={t("models.enableAll")}
              title={t("models.enableAllTitle", { count: allModelKeys.length })}
              onClick={() => onToggleModels(allModelKeys, true)}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 border-border bg-bg-main text-text-secondary hover:border-accent/40 hover:bg-accent-soft hover:text-accent"
            >
              <Icon name="check" size={12} strokeWidth={2.2} />
              {t("models.enableAll")}
            </button>
            <button
              type="button"
              data-testid="models-disable-all"
              disabled={allDisabled}
              aria-label={t("models.disableAll")}
              title={t("models.disableAllTitle", { count: allModelKeys.length })}
              onClick={() => onToggleModels(allModelKeys, false)}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 border-border bg-bg-main text-text-secondary hover:border-danger/30 hover:bg-danger/10 hover:text-danger"
            >
              <Icon name="x" size={12} strokeWidth={2.2} />
              {t("models.disableAll")}
            </button>
          </div>
        )}
      </div>
      {provider.models.length > 5 && (
        <div className="relative mb-3">
          <Icon
            name="search"
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
          />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder={t("models.searchPlaceholder")}
            aria-label={t("models.searchPlaceholder")}
            data-testid="model-search-input"
            className="w-full rounded-lg border border-border bg-bg-elevated py-2 pl-9 pr-3 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent"
          />
        </div>
      )}
      <div className="space-y-1.5">
        {provider.models.length === 0 && <div className="text-[12px] text-text-tertiary">{t("models.noModels")}</div>}
        {provider.models.length > 0 && filteredModels.length === 0 && (
          <div data-testid="model-search-empty" className="text-[12px] text-text-tertiary">
            {t("models.searchEmpty")}
          </div>
        )}
        {pageModels.map((m) => {
          const k = `${m.provider}/${m.modelId}`;
          const enabled = !disabledModels.has(k);
          return (
            <div key={k}>
              <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-elevated px-4 py-2.5">
                <Icon name="cpu" size={14} className="shrink-0 text-text-tertiary" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">{m.displayName}</span>
                {m.source === "custom" && (
                  <span
                    className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-text-secondary"
                    title={m.removable ? undefined : t("models.sourceCustomFileHint")}
                  >
                    {t("models.sourceCustom")}
                  </span>
                )}
                {m.reasoning && (
                  <span className="shrink-0 rounded-full bg-thinking/15 px-2 py-0.5 text-[11px] text-thinking">
                    {t("models.reasoning")}
                  </span>
                )}
                <button
                  type="button"
                  data-testid="model-pricing-toggle"
                  data-model={k}
                  aria-expanded={pricingFor === k}
                  onClick={() => setPricingFor(pricingFor === k ? null : k)}
                  className="shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-[11px] text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
                >
                  {t("models.pricing")}
                </button>
                {m.removable && (
                  <>
                    <button
                      type="button"
                      data-testid="model-edit"
                      data-model={k}
                      aria-expanded={editingModel === k}
                      aria-label={t("models.editNamed", { name: m.displayName })}
                      onClick={() => {
                        setEditingModel(editingModel === k ? null : k);
                        setPricingFor(null);
                      }}
                      className="flex h-7 shrink-0 items-center gap-1 rounded-lg border border-border bg-bg-main px-2.5 text-[11px] font-medium text-text-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-accent"
                    >
                      <Icon name="pen" size={12} />
                      {t("models.edit")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeModel(m)}
                      aria-label={t("models.delete", { name: m.displayName })}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border text-text-tertiary transition-colors hover:border-danger/30 hover:bg-danger/10 hover:text-danger"
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  data-testid="model-enabled-toggle"
                  data-model={k}
                  aria-pressed={enabled}
                  aria-label={t(enabled ? "models.disableNamed" : "models.enableNamed", { name: m.displayName })}
                  onClick={() => onToggleModel(k, !enabled)}
                  className={`flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-[11px] font-medium transition-colors ${
                    enabled
                      ? "border-accent/25 bg-accent-soft text-accent hover:border-danger/30 hover:bg-danger/10 hover:text-danger"
                      : "border-border bg-bg-main text-text-secondary hover:border-accent/40 hover:bg-accent-soft hover:text-accent"
                  }`}
                >
                  <Icon name={enabled ? "check" : "plus"} size={12} strokeWidth={2.2} />
                  {t(enabled ? "models.disableModel" : "models.enableModel")}
                </button>
              </div>
              {pricingFor === k && <ModelPricingEditor key={k} model={m} modelKey={k} />}
              {editingModel === k && (
                <AddModelForm
                  key={`edit-${k}`}
                  provider={m.provider}
                  model={m}
                  api={m.api}
                  onAdded={() => {
                    setEditingModel(null);
                    onChanged();
                  }}
                  onCancel={() => setEditingModel(null)}
                />
              )}
            </div>
          );
        })}
      </div>
      {totalPages > 1 && (
        <div className="mt-3 flex items-center justify-center gap-3" data-testid="model-pagination">
          <button
            type="button"
            data-testid="model-page-prev"
            disabled={currentPage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="rounded-lg border border-border bg-bg-elevated px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
          >
            {t("models.pagePrev")}
          </button>
          <span data-testid="model-page-info" className="tabular-nums text-[12px] text-text-tertiary">
            {t("models.pageInfo", { page: currentPage + 1, total: totalPages })}
          </span>
          <button
            type="button"
            data-testid="model-page-next"
            disabled={currentPage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            className="rounded-lg border border-border bg-bg-elevated px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
          >
            {t("models.pageNext")}
          </button>
        </div>
      )}

      <AddModelForm provider={provider.provider} api={provider.api ?? provider.models[0]?.api} onAdded={onChanged} />
    </div>
  );
}

/** 新增 / 编辑 Pi 内置目录之外的兼容供应商；密钥只经宿主写入 auth.json。 */
function ProviderFormModal({
  provider,
  onClose,
  onSaved,
}: {
  provider?: CatalogProvider;
  onClose: () => void;
  onSaved: (provider: string) => void;
}) {
  const { t } = useTranslation("settings");
  const [providerId, setProviderId] = useState(provider?.provider ?? "");
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [api, setApi] = useState(provider?.api ?? CUSTOM_PROVIDER_APIS[0]);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input: CustomProviderInput = {
    provider: providerId.trim(),
    name: name.trim(),
    baseUrl: baseUrl.trim(),
    api,
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
  };
  const validationError = validateCustomProviderInput(input);
  const shownError = error ?? (attempted ? validationError : null);

  const submit = async () => {
    setAttempted(true);
    if (validationError || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (provider) await window.spcode.command({ type: "models.updateProvider", payload: input });
      else await window.spcode.command({ type: "models.addProvider", payload: input });
      onSaved(input.provider);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t(provider ? "models.editProvider" : "models.addProvider")}
      description={t("models.providerFormDescription")}
      onClose={onClose}
      busy={busy}
      layerClassName="items-center justify-center"
      panelClassName="w-[580px] max-w-[92vw] rounded-2xl border border-border-strong bg-bg-main p-6 shadow-2xl"
      testId="provider-form-modal"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 className="text-[18px] font-semibold text-text-primary">
          {t(provider ? "models.editProvider" : "models.addProvider")}
        </h2>
        <p className="mt-1 text-[12px] leading-5 text-text-tertiary">{t("models.providerFormDescription")}</p>
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[12px] text-text-secondary">{t("models.providerId")}</span>
            <input
              value={providerId}
              disabled={!!provider}
              data-modal-initial-focus={!provider ? true : undefined}
              data-testid="provider-id-input"
              onChange={(event) => setProviderId(event.target.value)}
              placeholder={t("models.providerIdPlaceholder")}
              className="w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-[13px] outline-none placeholder:text-text-tertiary focus:border-accent disabled:opacity-60"
            />
            <span className="mt-1 block text-[11px] text-text-tertiary">{t("models.providerIdHint")}</span>
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-text-secondary">{t("models.providerName")}</span>
            <input
              value={name}
              data-modal-initial-focus={provider ? true : undefined}
              data-testid="provider-name-input"
              onChange={(event) => setName(event.target.value)}
              placeholder={t("models.providerNamePlaceholder")}
              className="w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-[13px] outline-none placeholder:text-text-tertiary focus:border-accent"
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-[12px] text-text-secondary">{t("models.providerBaseUrl")}</span>
            <input
              value={baseUrl}
              data-testid="provider-base-url-input"
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={t("models.providerBaseUrlPlaceholder")}
              inputMode="url"
              className="mono w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-[13px] outline-none placeholder:text-text-tertiary focus:border-accent"
            />
          </label>
          <div>
            <span className="mb-1 block text-[12px] text-text-secondary">{t("models.providerApi")}</span>
            <Select
              value={api}
              options={CUSTOM_PROVIDER_APIS.map((value) => ({ value }))}
              onChange={setApi}
              label={t("models.providerApi")}
              testId="provider-api-select"
            />
          </div>
          <label className="block">
            <span className="mb-1 block text-[12px] text-text-secondary">{t("models.providerApiKey")}</span>
            <input
              type="password"
              value={apiKey}
              data-testid="provider-api-key-input"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={t(provider?.configured ? "models.providerKeyKeep" : "models.providerKeyOptional")}
              autoComplete="off"
              className="w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-[13px] outline-none placeholder:text-text-tertiary focus:border-accent"
            />
          </label>
        </div>
        <p className="mt-3 text-[11px] leading-5 text-text-tertiary">{t("models.providerKeyHint")}</p>
        {shownError && (
          <p role="alert" className="mt-3 text-[12px] text-danger">
            {shownError.startsWith("models.") ? t(shownError as "models.providerInvalidId") : shownError}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-border px-4 py-2 text-[12px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
          >
            {t("cancel")}
          </button>
          <button
            type="submit"
            data-testid="provider-save"
            disabled={busy}
            className="rounded-lg bg-accent px-4 py-2 text-[12px] text-on-accent hover:bg-accent-dim disabled:opacity-40"
          >
            {busy ? t("saving") : t("save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 单模型四项费率：默认取目录价，覆盖只影响保存后的新用量。 */
function ModelPricingEditor({ model, modelKey }: { model: CatalogModel; modelKey: string }) {
  const { t } = useTranslation("settings");
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const override = settings?.modelPricing?.[modelKey];
  const toText = (rates: ModelPriceRates): Record<keyof ModelPriceRates, string> => ({
    input: String(rates.input),
    output: String(rates.output),
    cacheRead: String(rates.cacheRead),
    cacheWrite: String(rates.cacheWrite),
  });
  const [rates, setRates] = useState<Record<keyof ModelPriceRates, string>>(() => toText(override ?? model.cost));
  const [invalid, setInvalid] = useState(false);
  const fields = [
    { key: "input", label: t("models.priceInput") },
    { key: "output", label: t("models.priceOutput") },
    { key: "cacheRead", label: t("models.priceCacheRead") },
    { key: "cacheWrite", label: t("models.priceCacheWrite") },
  ] as const;

  const save = async () => {
    const next = {} as ModelPriceRates;
    for (const field of fields) {
      const raw = rates[field.key].trim();
      const value = Number(raw);
      if (!raw || !Number.isFinite(value) || value < 0) {
        setInvalid(true);
        return;
      }
      next[field.key] = value;
    }
    setInvalid(false);
    await saveSettings({ modelPricing: { ...(settings?.modelPricing ?? {}), [modelKey]: next } });
  };

  const reset = async () => {
    const next = { ...(settings?.modelPricing ?? {}) };
    delete next[modelKey];
    await saveSettings({ modelPricing: next });
    setRates(toText(model.cost));
    setInvalid(false);
  };

  return (
    <div data-testid="model-pricing-editor" className="mt-1 rounded-xl border border-border bg-bg-main px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-text-secondary">
          {override
            ? t("models.pricingCustom")
            : model.priceKnown
              ? t("models.pricingDefault")
              : t("models.pricingUnpriced")}
        </span>
        {override && (
          <button
            type="button"
            data-testid="model-pricing-reset"
            onClick={() => void reset()}
            className="text-[11px] text-text-tertiary hover:text-text-primary"
          >
            {t("models.pricingReset")}
          </button>
        )}
      </div>
      <p className="mt-1 text-[11px] leading-snug text-text-tertiary">{t("models.pricingDescription")}</p>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {fields.map((field) => (
          <label key={field.key} className="block">
            <span className="mb-1 block text-[11px] text-text-tertiary">{field.label}</span>
            <input
              type="number"
              min={0}
              step="any"
              value={rates[field.key]}
              data-testid={`model-price-${field.key}`}
              onChange={(e) => setRates((current) => ({ ...current, [field.key]: e.target.value }))}
              className="mono w-full rounded-lg border border-border bg-bg-elevated px-2 py-1.5 text-[12px] outline-none focus:border-accent"
            />
          </label>
        ))}
      </div>
      {invalid && <p className="mt-2 text-[11px] text-danger">{t("models.pricingInvalid")}</p>}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          data-testid="model-pricing-save"
          onClick={() => void save()}
          className="rounded-lg bg-accent px-3 py-1.5 text-[12px] text-on-accent hover:bg-accent-dim"
        >
          {t("models.pricingSave")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 添加 / 编辑自定义模型：写入 models.custom.json，按 provider 默认协议请求
// ---------------------------------------------------------------------------

function AddModelForm({
  provider,
  api,
  onAdded,
  model,
  onCancel,
}: {
  provider: string;
  api?: string;
  onAdded: () => void;
  /** 传入时进入编辑模式：ID 固定，其余字段回填后通过同 ID 覆盖保存 */
  model?: CatalogModel;
  onCancel?: () => void;
}) {
  const { t } = useTranslation("settings");
  const fieldId = useId();
  const [modelId, setModelId] = useState(model?.modelId ?? "");
  const [displayName, setDisplayName] = useState(model && model.displayName !== model.modelId ? model.displayName : "");
  const [context, setContext] = useState(model?.contextWindow ? String(model.contextWindow) : "");
  const [reasoning, setReasoning] = useState(model?.reasoning ?? true);
  const [vision, setVision] = useState(model?.vision ?? false);
  const [systemMessageRole, setSystemMessageRole] = useState<SystemMessageRole>(
    model?.systemMessageRole ?? "auto",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ctxNum = Number(context);
  // 空输入不报错（未填状态）；有内容后按通用规则校验；上下文为空单独提示必填，
  // 避免 placeholder 被误认为已填值时报出「范围不符」的误导文案
  const validationError = modelId.trim()
    ? !context.trim()
      ? "models.contextRequired"
      : validateModelInput({ modelId, contextWindow: ctxNum })
    : null;

  const submit = async () => {
    if (validationError || busy) return;
    setBusy(true);
    setError(null);
    const payload: AddCustomModelInput = {
      provider,
      modelId: modelId.trim(),
      displayName: displayName.trim() || undefined,
      contextWindow: ctxNum,
      reasoning,
      vision,
      systemMessageRole,
    };
    try {
      await window.spcode.command({ type: "models.addModel", payload });
      if (!model) {
        setModelId("");
        setDisplayName("");
        setContext("");
        setReasoning(true);
        setVision(false);
        setSystemMessageRole("auto");
      }
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid={model ? "custom-model-edit-form" : "custom-model-add-form"}
      className={`rounded-xl border p-4 ${model ? "mt-1 border-accent/30 bg-bg-main" : "mt-6 border-border bg-bg-elevated"}`}
    >
      <div className="flex items-center gap-2 text-[13px] font-semibold text-text-secondary">
        {model && <Icon name="pen" size={13} className="text-accent" />}
        {t(model ? "models.editModel" : "models.addModel")}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-[12px] text-text-tertiary">{t("models.addModelId")}</span>
          <input
            value={modelId}
            disabled={!!model}
            data-testid="custom-model-id-input"
            onChange={(e) => setModelId(e.target.value)}
            placeholder={t("models.addModelIdPlaceholder")}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none placeholder:text-text-tertiary focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] text-text-tertiary">{t("models.addModelName")}</span>
          <input
            value={displayName}
            data-testid="custom-model-name-input"
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t("models.addModelNamePlaceholder")}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none placeholder:text-text-tertiary focus:border-accent"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] text-text-tertiary">{t("models.addModelContext")}</span>
          <input
            type="number"
            min={1}
            value={context}
            data-testid="custom-model-context-input"
            onChange={(e) => setContext(e.target.value)}
            placeholder="262144"
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none placeholder:text-text-tertiary focus:border-accent"
          />
        </label>
      </div>
      {["openai-completions", "openai-responses", "azure-openai-responses", "openai-codex-responses"].includes(
        api ?? "",
      ) && (
        <div className="mt-3 max-w-md">
          <span className="mb-1 block text-[12px] text-text-tertiary">{t("models.systemMessageRole")}</span>
          <Select
            value={systemMessageRole}
            options={[
              { value: "auto", label: t("models.systemMessageRoleAuto") },
              { value: "system", label: "system" },
              { value: "developer", label: t("models.systemMessageRoleDeveloper") },
            ]}
            onChange={(value) => setSystemMessageRole(value as SystemMessageRole)}
            label={t("models.systemMessageRole")}
            testId="custom-model-system-role-select"
          />
          <p className="mt-1 text-[11px] leading-snug text-text-tertiary">{t("models.systemMessageRoleHint")}</p>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        <label htmlFor={`${fieldId}-reasoning`} className="flex items-center gap-2 text-[13px] text-text-secondary">
          <Switch
            id={`${fieldId}-reasoning`}
            on={reasoning}
            onChange={setReasoning}
            label={t("models.addModelReasoning")}
          />
          {t("models.addModelReasoning")}
        </label>
        <label htmlFor={`${fieldId}-vision`} className="flex items-center gap-2 text-[13px] text-text-secondary">
          <Switch id={`${fieldId}-vision`} on={vision} onChange={setVision} label={t("models.addModelVision")} />
          {t("models.addModelVision")}
        </label>
        <div className="ml-auto flex items-center gap-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-lg border border-border px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
            >
              {t("cancel")}
            </button>
          )}
          <button
            type="button"
            data-testid="custom-model-submit"
            onClick={() => void submit()}
            disabled={!!validationError || !modelId.trim() || !context.trim() || busy}
            className="rounded-lg bg-accent px-4 py-1.5 text-[12px] text-on-accent hover:bg-accent-dim disabled:opacity-40"
          >
            {busy ? t("saving") : t(model ? "models.saveModel" : "models.addModelSubmit")}
          </button>
        </div>
      </div>
      <p className="mt-2 text-[12px] text-text-tertiary">{t(model ? "models.editModelHint" : "models.addModelHint")}</p>
      {(validationError || error) && (
        <p className="mt-1 text-[12px] text-danger">
          {validationError ? t(validationError) : t(error as "models.notRemovable")}
        </p>
      )}
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
