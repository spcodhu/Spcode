import type { ModelInfo, ModelRef } from "@spcode/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorText } from "../lib/i18n";
import { refreshModels } from "../state/controller";
import { useAppStore } from "../state/store";
import { Sheet } from "./Sheet";

function modelKey(model: ModelRef): string {
  return `${model.provider}/${model.modelId}`;
}

function sameModel(a: ModelRef | null, b: ModelRef | null): boolean {
  return !!a && !!b && a.provider === b.provider && a.modelId === b.modelId;
}

function ModelOptions({
  models,
  selected,
  onSelect,
}: {
  models: ModelInfo[];
  selected: ModelRef | null;
  onSelect: (model: ModelRef) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, ModelInfo[]>();
    for (const model of models) {
      const list = map.get(model.provider) ?? [];
      list.push(model);
      map.set(model.provider, list);
    }
    return [...map.entries()];
  }, [models]);

  return (
    <div className="space-y-4">
      {groups.map(([provider, items]) => (
        <section key={provider}>
          <h3 className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">{provider}</h3>
          <div className="space-y-1.5" role="listbox" aria-label={provider}>
            {items.map((model) => {
              const active = sameModel(model, selected);
              return (
                <button
                  key={modelKey(model)}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-testid="model-option"
                  data-model={modelKey(model)}
                  onClick={() => onSelect({ provider: model.provider, modelId: model.modelId })}
                  className={`flex min-h-12 w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
                    active ? "border-accent bg-accent-soft" : "border-border bg-bg-elevated active:bg-bg-active"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-text-primary">{model.displayName}</span>
                    {model.displayName !== model.modelId && (
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-text-tertiary">
                        {model.modelId}
                      </span>
                    )}
                  </span>
                  <span aria-hidden="true" className={`shrink-0 ${active ? "text-accent" : "text-transparent"}`}>
                    ✓
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

export function ModelPickerSheet({
  value,
  allowDefault = false,
  inferDefault = true,
  onSelect,
  onClose,
}: {
  value: ModelRef | null;
  /** true = 提供“跟随 PC 默认”选项（定时任务）；false = 缺省值可按 inferDefault 解析 */
  allowDefault?: boolean;
  /** 新建会话允许空值跟随 PC 默认；已有会话空值必须保持“未选择” */
  inferDefault?: boolean;
  onSelect: (model: ModelRef | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("mobile");
  const models = useAppStore((s) => s.models);
  const defaultModel = useAppStore((s) => s.defaultModel);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await refreshModels();
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const selected = value ?? (allowDefault || !inferDefault ? null : defaultModel);
  return (
    <Sheet title={t("models.title")} onClose={onClose}>
      {loading && (
        <div role="status" className="py-8 text-center text-sm text-text-tertiary">
          {t("models.loading")}
        </div>
      )}
      {error != null && (
        <div
          role="alert"
          className="safe-break mb-3 rounded-xl border border-red-900/60 bg-red-950/40 px-3 py-2.5 text-xs leading-5 text-red-300"
        >
          <div>{errorText(error)}</div>
          <button type="button" onClick={() => void load()} className="mt-1 min-h-11 px-1 text-red-100 underline">
            {t("session.retry")}
          </button>
        </div>
      )}
      {!loading && error == null && models.length === 0 && !allowDefault && (
        <div className="py-8 text-center text-sm leading-6 text-text-tertiary">{t("models.empty")}</div>
      )}
      {!loading && (
        <div className="space-y-3">
          {allowDefault && (
            <button
              type="button"
              role="option"
              aria-selected={value === null}
              data-testid="model-option-default"
              onClick={() => onSelect(null)}
              className={`min-h-12 w-full rounded-xl border px-3.5 py-2.5 text-left text-sm font-medium ${
                value === null
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border bg-bg-elevated text-text-primary"
              }`}
            >
              {t("models.followDefault")}
            </button>
          )}
          <ModelOptions models={models} selected={selected} onSelect={onSelect} />
        </div>
      )}
    </Sheet>
  );
}

export function ModelField({
  value,
  allowDefault = false,
  inferDefault = true,
  disabled = false,
  onChange,
}: {
  value: ModelRef | null;
  allowDefault?: boolean;
  inferDefault?: boolean;
  disabled?: boolean;
  onChange: (model: ModelRef | null) => void;
}) {
  const { t } = useTranslation("mobile");
  const models = useAppStore((s) => s.models);
  const defaultModel = useAppStore((s) => s.defaultModel);
  const connState = useAppStore((s) => s.connState);
  const [open, setOpen] = useState(false);
  const effective = value ?? (allowDefault || !inferDefault ? null : defaultModel);
  const info = effective ? models.find((model) => sameModel(model, effective)) : undefined;
  const label =
    allowDefault && value === null
      ? t("models.followDefault")
      : (info?.displayName ?? effective?.modelId ?? t("models.unconfigured"));

  return (
    <>
      <button
        type="button"
        data-testid="model-field"
        disabled={disabled || connState !== "ready"}
        onClick={() => setOpen(true)}
        className="flex min-h-11 w-full items-center gap-2 rounded-xl border border-border-strong bg-bg-main/70 px-3 py-2.5 text-left text-sm text-text-primary outline-none transition-colors focus:border-accent disabled:opacity-40"
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span aria-hidden="true" className="shrink-0 text-text-tertiary">
          ⌄
        </span>
      </button>
      {open && (
        <ModelPickerSheet
          value={value}
          allowDefault={allowDefault}
          inferDefault={inferDefault}
          onClose={() => setOpen(false)}
          onSelect={(model) => {
            onChange(model);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
