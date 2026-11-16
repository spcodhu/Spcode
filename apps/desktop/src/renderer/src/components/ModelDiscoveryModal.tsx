import type {
  AddCustomModelInput,
  CatalogProvider,
  DiscoveredModel,
  ModelDiscoveryResult,
  ModelImportResult,
  SystemMessageRole,
} from "@spcode/shared";
import { validateModelInput } from "@spcode/shared";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./ui/Modal";
import { Select } from "./ui/Select";
import { Switch } from "./ui/Switch";

const ROLE_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);

/** 在线列表只负责发现；能力默认值由用户在导入前显式确认。 */
export function ModelDiscoveryModal({
  provider,
  onClose,
  onImported,
}: {
  provider: CatalogProvider;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useTranslation("settings");
  const fieldId = useId();
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [defaultContext, setDefaultContext] = useState("128000");
  const [defaultMaxTokens, setDefaultMaxTokens] = useState("16384");
  const [defaultReasoning, setDefaultReasoning] = useState(false);
  const [defaultVision, setDefaultVision] = useState(false);
  const [defaultRole, setDefaultRole] = useState<SystemMessageRole>("auto");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ModelImportResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoaded(false);
    setError(null);
    setWarnings([]);
    setImportResult(null);
    setSelected(new Set());
    try {
      const result = await window.spcode.command<ModelDiscoveryResult>({
        type: "models.discoverModels",
        payload: { provider: provider.provider },
      });
      setModels(result?.models ?? []);
      setWarnings(result?.warnings ?? []);
      setLoaded(true);
    } catch (cause) {
      setModels([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [provider.provider]);

  useEffect(() => {
    void load();
  }, [load]);

  const existingIds = useMemo(() => new Set(provider.models.map((model) => model.modelId)), [provider.models]);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return models;
    return models.filter(
      (model) => model.id.toLowerCase().includes(keyword) || (model.displayName ?? "").toLowerCase().includes(keyword),
    );
  }, [models, query]);
  const contextNumber = Number(defaultContext);
  const maxTokensNumber = Number(defaultMaxTokens);
  const defaultsError = validateModelInput({
    modelId: "import-defaults",
    contextWindow: contextNumber,
    maxTokens: maxTokensNumber,
  });
  const shownError = error ? (error.startsWith("models.") ? t(error as "models.discoveryUnsupported") : error) : null;

  const toggle = (model: DiscoveredModel, checked: boolean) => {
    if (existingIds.has(model.id)) return;
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(model.id);
      else next.delete(model.id);
      return next;
    });
  };

  const importSelected = async () => {
    if (importing || selected.size === 0 || defaultsError) return;
    setImporting(true);
    setError(null);
    setImportResult(null);
    const byId = new Map(models.map((model) => [model.id, model]));
    const payload: AddCustomModelInput[] = [...selected].flatMap((id) => {
      const model = byId.get(id);
      if (!model || existingIds.has(id)) return [];
      return [
        {
          provider: provider.provider,
          modelId: model.id,
          displayName: model.displayName,
          contextWindow: model.contextWindow ?? contextNumber,
          maxTokens: model.maxTokens ?? maxTokensNumber,
          reasoning: model.reasoning ?? defaultReasoning,
          vision: model.vision ?? defaultVision,
          systemMessageRole: defaultRole,
        },
      ];
    });
    try {
      const result = await window.spcode.command<ModelImportResult>({
        type: "models.importModels",
        payload: { provider: provider.provider, models: payload },
      });
      const normalized = result ?? { added: [], skipped: [] };
      setImportResult(normalized);
      setSelected(new Set());
      if (normalized.added.length > 0) onImported();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      title={t("models.discoveryTitle")}
      description={t("models.discoveryDescription")}
      onClose={onClose}
      busy={importing}
      layerClassName="items-center justify-center"
      panelClassName="flex max-h-[88vh] w-[760px] max-w-[94vw] flex-col overflow-y-auto rounded-2xl border border-border-strong bg-bg-main p-5 shadow-2xl"
      testId="model-discovery-modal"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[18px] font-semibold text-text-primary">{t("models.discoveryTitle")}</h2>
          <p className="mt-1 text-[12px] leading-5 text-text-tertiary">{t("models.discoveryDescription")}</p>
        </div>
        <button
          type="button"
          data-testid="model-discovery-close"
          onClick={onClose}
          disabled={importing}
          className="rounded-lg border border-border px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
        >
          {t("close")}
        </button>
      </div>

      <div className="mt-4 min-h-44">
        {loading ? (
          <div className="flex h-44 items-center justify-center rounded-xl border border-border bg-bg-elevated text-[13px] text-text-tertiary">
            {t("loading")}
          </div>
        ) : (
          <>
            {shownError && (
              <div role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-[12px] text-danger">
                <div className="break-words">{shownError}</div>
                <button
                  type="button"
                  data-testid="model-discovery-retry"
                  onClick={() => void load()}
                  className="mt-3 rounded-lg border border-danger/40 px-3 py-1.5 hover:bg-danger/10"
                >
                  {t("retry")}
                </button>
              </div>
            )}
            {loaded && !shownError && models.length === 0 && (
              <div
                data-testid="model-discovery-empty"
                className="flex h-44 items-center justify-center rounded-xl border border-border bg-bg-elevated text-[13px] text-text-tertiary"
              >
                {t("models.discoveryEmpty")}
              </div>
            )}
            {models.length > 0 && (
              <>
                {warnings.map((warning) => (
                  <p
                    key={warning}
                    className="mb-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-[12px] text-warning"
                  >
                    {warning.startsWith("models.") ? t(warning as "models.discoveryTruncated") : warning}
                  </p>
                ))}
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t("models.discoverySearchPlaceholder")}
                    aria-label={t("models.discoverySearchPlaceholder")}
                    data-testid="model-discovery-search"
                    data-modal-initial-focus
                    className="min-w-0 flex-1 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-[13px] outline-none placeholder:text-text-tertiary focus:border-accent"
                  />
                  <button
                    type="button"
                    data-testid="model-discovery-select-new"
                    onClick={() =>
                      setSelected(
                        new Set(models.filter((model) => !existingIds.has(model.id)).map((model) => model.id)),
                      )
                    }
                    className="rounded-lg border border-border px-3 py-2 text-[12px] text-text-secondary hover:bg-bg-hover"
                  >
                    {t("models.discoverySelectNew")}
                  </button>
                  <button
                    type="button"
                    data-testid="model-discovery-clear"
                    onClick={() => setSelected(new Set())}
                    disabled={selected.size === 0}
                    className="rounded-lg border border-border px-3 py-2 text-[12px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
                  >
                    {t("models.discoveryClear")}
                  </button>
                </div>
                <div className="mt-3 max-h-56 space-y-1 overflow-y-auto rounded-xl border border-border p-1.5">
                  {filtered.map((model) => {
                    const existing = existingIds.has(model.id);
                    const hasRemoteMetadata = !!(
                      model.contextWindow ||
                      model.maxTokens ||
                      model.reasoning !== undefined ||
                      model.vision !== undefined
                    );
                    return (
                      <label
                        key={model.id}
                        className={`flex items-center gap-3 rounded-lg px-2.5 py-2 ${existing ? "opacity-55" : "hover:bg-bg-hover"}`}
                      >
                        <input
                          type="checkbox"
                          data-testid="discovered-model-checkbox"
                          data-model={model.id}
                          checked={selected.has(model.id)}
                          disabled={existing || importing}
                          onChange={(event) => toggle(model, event.target.checked)}
                          className="h-4 w-4 shrink-0 accent-accent"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="mono block truncate text-[12px] text-text-primary">{model.id}</span>
                          {model.displayName && model.displayName !== model.id && (
                            <span className="block truncate text-[11px] text-text-tertiary">{model.displayName}</span>
                          )}
                        </span>
                        {hasRemoteMetadata && (
                          <span className="shrink-0 text-[10px] text-text-tertiary">
                            {t("models.discoveryRemoteMetadata")}
                          </span>
                        )}
                        {model.status && (
                          <span className="shrink-0 text-[10px] text-text-tertiary">{model.status}</span>
                        )}
                        {existing && (
                          <span className="shrink-0 text-[11px] text-text-tertiary">
                            {t("models.discoveryExisting")}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {models.length > 0 && (
        <div className="mt-4 rounded-xl border border-border bg-bg-elevated p-3">
          <div className="text-[12px] font-semibold text-text-secondary">{t("models.discoveryDefaults")}</div>
          <p className="mt-1 text-[11px] leading-snug text-text-tertiary">{t("models.discoveryDefaultsHint")}</p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label>
              <span className="mb-1 block text-[11px] text-text-tertiary">{t("models.addModelContext")}</span>
              <input
                type="number"
                min={1}
                value={defaultContext}
                data-testid="discovery-default-context"
                onChange={(event) => setDefaultContext(event.target.value)}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[12px] outline-none focus:border-accent"
              />
            </label>
            <label>
              <span className="mb-1 block text-[11px] text-text-tertiary">{t("models.addModelMaxTokens")}</span>
              <input
                type="number"
                min={1}
                value={defaultMaxTokens}
                data-testid="discovery-default-max-tokens"
                onChange={(event) => setDefaultMaxTokens(event.target.value)}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[12px] outline-none focus:border-accent"
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-5">
            <label htmlFor={`${fieldId}-reasoning`} className="flex items-center gap-2 text-[12px] text-text-secondary">
              <Switch
                id={`${fieldId}-reasoning`}
                on={defaultReasoning}
                onChange={setDefaultReasoning}
                label={t("models.addModelReasoning")}
              />
              {t("models.addModelReasoning")}
            </label>
            <label htmlFor={`${fieldId}-vision`} className="flex items-center gap-2 text-[12px] text-text-secondary">
              <Switch
                id={`${fieldId}-vision`}
                on={defaultVision}
                onChange={setDefaultVision}
                label={t("models.addModelVision")}
              />
              {t("models.addModelVision")}
            </label>
          </div>
          {ROLE_APIS.has(provider.api ?? "") && (
            <div className="mt-3 max-w-sm">
              <Select
                value={defaultRole}
                options={[
                  { value: "auto", label: t("models.systemMessageRoleAuto") },
                  { value: "system", label: "system" },
                  { value: "developer", label: t("models.systemMessageRoleDeveloper") },
                ]}
                onChange={(value) => setDefaultRole(value as SystemMessageRole)}
                label={t("models.systemMessageRole")}
                testId="discovery-default-role"
              />
            </div>
          )}
          {defaultsError && defaultContext.trim() && defaultMaxTokens.trim() && (
            <p className="mt-2 text-[11px] text-danger">{t(defaultsError)}</p>
          )}
        </div>
      )}

      <div className="mt-4 flex min-h-9 items-center justify-between gap-3">
        <div className="min-w-0 text-[12px] text-text-tertiary">
          {importResult && (
            <span data-testid="model-discovery-import-result">
              {t("models.discoveryImportResult", {
                added: importResult.added.length,
                skipped: importResult.skipped.length,
              })}
            </span>
          )}
        </div>
        <button
          type="button"
          data-testid="models-import-selected"
          disabled={selected.size === 0 || !!defaultsError || importing || loading}
          onClick={() => void importSelected()}
          className="shrink-0 rounded-lg bg-accent px-4 py-2 text-[12px] text-on-accent hover:bg-accent-dim disabled:opacity-40"
        >
          {importing ? t("saving") : t("models.discoveryImportSelected", { count: selected.size })}
        </button>
      </div>
    </Modal>
  );
}
