import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AddCustomModelInput, CatalogModel, CatalogProvider } from "@spcode/shared";
import { validateModelInput } from "@spcode/shared";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { Switch } from "./ui/Switch";

export type { CatalogModel, CatalogProvider };

export function ModelsPage() {
  const { t } = useTranslation("settings");
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

  // 目录变化（添加/删除自定义模型）后 Composer 的可用模型列表也要重拉
  const handleChanged = useCallback(() => {
    reload();
    void refreshModels();
  }, [reload, refreshModels]);

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
          onChanged={handleChanged}
        />
      ) : (
        <>
          <PageHeader title={t("nav.models")} subtitle={t("models.description")} />

          <GroupTitle>{t("models.configured")}</GroupTitle>
          <div className="space-y-2">
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
  const { t } = useTranslation("settings");
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
  onBack,
  onChanged,
}: {
  provider: CatalogProvider;
  disabledModels: Set<string>;
  onToggleModel: (key: string, enable: boolean) => void;
  onBack: () => void;
  /** 目录变化（存密钥 / 增删模型）后重拉目录与可用模型列表 */
  onChanged: () => void;
}) {
  const { t } = useTranslation("settings");
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(false);

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
    onChanged();
  };

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
      <h1 className="text-[22px] font-semibold text-text-primary">{provider.name}</h1>
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

      <div className="mb-2 mt-6 text-[13px] font-semibold text-text-secondary">
        {t("models.availableCount", { count: provider.models.length })}
      </div>
      <div className="space-y-1.5">
        {provider.models.length === 0 && <div className="text-[12px] text-text-tertiary">{t("models.noModels")}</div>}
        {provider.models.map((m) => {
          const k = `${m.provider}/${m.modelId}`;
          const enabled = !disabledModels.has(k);
          return (
            <div key={k} className="flex items-center gap-3 rounded-xl border border-border bg-bg-elevated px-4 py-2.5">
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
              {m.removable && (
                <button
                  type="button"
                  onClick={() => void removeModel(m)}
                  aria-label={t("models.delete", { name: m.displayName })}
                  className="shrink-0 text-text-tertiary hover:text-danger"
                >
                  <Icon name="trash" size={14} />
                </button>
              )}
              <Switch
                on={enabled}
                onChange={(v) => onToggleModel(k, v)}
                label={t("enableName", { name: m.displayName })}
              />
            </div>
          );
        })}
      </div>

      <AddModelForm provider={provider.provider} onAdded={onChanged} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 添加自定义模型：表单写入 models.custom.json，按 provider 默认协议请求
// ---------------------------------------------------------------------------

function AddModelForm({ provider, onAdded }: { provider: string; onAdded: () => void }) {
  const { t } = useTranslation("settings");
  const [modelId, setModelId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [context, setContext] = useState("");
  const [reasoning, setReasoning] = useState(true);
  const [vision, setVision] = useState(false);
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
    };
    try {
      await window.spcode.command({ type: "models.addModel", payload });
      setModelId("");
      setDisplayName("");
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 rounded-xl border border-border bg-bg-elevated p-4">
      <div className="text-[13px] font-semibold text-text-secondary">{t("models.addModel")}</div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-[12px] text-text-tertiary">{t("models.addModelId")}</span>
          <input
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            placeholder={t("models.addModelIdPlaceholder")}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none placeholder:text-text-tertiary focus:border-accent"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] text-text-tertiary">{t("models.addModelName")}</span>
          <input
            value={displayName}
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
            onChange={(e) => setContext(e.target.value)}
            placeholder="262144"
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none placeholder:text-text-tertiary focus:border-accent"
          />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        <label className="flex items-center gap-2 text-[13px] text-text-secondary">
          <Switch on={reasoning} onChange={setReasoning} label={t("models.addModelReasoning")} />
          {t("models.addModelReasoning")}
        </label>
        <label className="flex items-center gap-2 text-[13px] text-text-secondary">
          <Switch on={vision} onChange={setVision} label={t("models.addModelVision")} />
          {t("models.addModelVision")}
        </label>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!!validationError || !modelId.trim() || !context.trim() || busy}
          className="ml-auto rounded-lg bg-accent px-4 py-1.5 text-[12px] text-on-accent hover:bg-accent-dim disabled:opacity-40"
        >
          {t("models.addModelSubmit")}
        </button>
      </div>
      <p className="mt-2 text-[12px] text-text-tertiary">{t("models.addModelHint")}</p>
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
