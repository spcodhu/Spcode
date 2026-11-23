import type { SuperAgentCommand, SuperAgentPublicConfig } from "@spcode/shared/superagent";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";

export function SuperAgentSettings({
  config,
  busy,
  execute,
}: {
  config: SuperAgentPublicConfig | null;
  busy: boolean;
  execute: (command: SuperAgentCommand) => Promise<void>;
}) {
  const { t } = useTranslation("superagent");
  const [enabled, setEnabled] = useState(false);
  const [concurrency, setConcurrency] = useState("2");
  const [defaultRepo, setDefaultRepo] = useState("");
  const [digestChatId, setDigestChatId] = useState("");
  const [dailyTime, setDailyTime] = useState("09:00");
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [budget, setBudget] = useState("20");
  const [operators, setOperators] = useState("");
  const [chats, setChats] = useState("");
  const [repositories, setRepositories] = useState("[]");
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!config) return;
    setEnabled(config.enabled);
    setConcurrency(String(config.concurrency));
    setDefaultRepo(config.defaultRepo);
    setDigestChatId(config.digestChatId);
    setDailyTime(config.dailyDigestTime);
    setTimezone(config.timezone);
    setBudget(String(config.budgetUsd));
    setOperators(config.authorizedOperators.join(", "));
    setChats(config.allowedChats.join(", "));
    setRepositories(JSON.stringify(config.repositories, null, 2));
    setProvider(config.model?.provider ?? "");
    setModelId(config.model?.modelId ?? "");
  }, [config]);

  const save = async () => {
    try {
      const parsed = JSON.parse(repositories) as unknown;
      if (!Array.isArray(parsed)) throw new Error("repositories must be an array");
      setError("");
      await execute({
        type: "config.update",
        patch: {
          enabled,
          concurrency: Number(concurrency),
          defaultRepo: defaultRepo.trim(),
          digestChatId: digestChatId.trim(),
          dailyDigestTime: dailyTime,
          timezone: timezone.trim(),
          budgetUsd: Number(budget),
          authorizedOperators: operators
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          allowedChats: chats
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          repositories: parsed,
          model: provider.trim() && modelId.trim() ? { provider: provider.trim(), modelId: modelId.trim() } : null,
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="rounded-xl border border-border bg-bg-elevated p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-medium text-text-primary">{t("settings.title")}</h2>
            <p className="mt-1 text-[11px] text-text-tertiary">{t("settings.subtitle")}</p>
          </div>
          <label className="flex items-center gap-2 text-[12px] text-text-primary">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            {t("settings.enabled")}
          </label>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <NumberField
            label={t("settings.concurrency")}
            value={concurrency}
            onChange={setConcurrency}
            min="1"
            max="8"
          />
          <NumberField label={t("settings.budget")} value={budget} onChange={setBudget} min="0" />
          <TextField label={t("settings.defaultRepo")} value={defaultRepo} onChange={setDefaultRepo} mono />
          <TextField label={t("settings.digestChat")} value={digestChatId} onChange={setDigestChatId} mono />
          <TextField label={t("settings.dailyTime")} value={dailyTime} onChange={setDailyTime} mono />
          <TextField label={t("settings.timezone")} value={timezone} onChange={setTimezone} mono />
          <TextField label={t("settings.provider")} value={provider} onChange={setProvider} mono />
          <TextField label={t("settings.model")} value={modelId} onChange={setModelId} mono />
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <TextAreaField label={t("settings.operators")} value={operators} onChange={setOperators} rows={3} />
          <TextAreaField label={t("settings.chats")} value={chats} onChange={setChats} rows={3} />
        </div>
        <TextAreaField
          label={t("settings.repositories")}
          value={repositories}
          onChange={setRepositories}
          rows={12}
          mono
        />
        <p className="mt-2 text-[11px] leading-5 text-text-tertiary">{t("settings.repositoryHint")}</p>

        {error && (
          <div
            className="mt-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[11px] text-danger"
            role="alert"
          >
            {error}
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="rounded-lg bg-accent px-4 py-2 text-[12px] text-on-accent disabled:opacity-40"
            data-testid="save-superagent-config"
          >
            {t("settings.save")}
          </button>
        </div>
      </section>

      <aside className="space-y-4">
        <section className="rounded-xl border border-border bg-bg-elevated p-4">
          <h3 className="text-[13px] font-medium text-text-primary">{t("settings.credentials")}</h3>
          <Credential label={t("settings.github")} configured={config?.credentials.github === true} />
          <Credential label={t("settings.feishu")} configured={config?.credentials.feishu === true} />
          <Credential label={t("settings.botIdentity")} configured={config?.credentials.botIdentity === true} />
          <p className="mt-3 text-[11px] leading-5 text-text-tertiary">{t("settings.credentialsHint")}</p>
        </section>
        <section className="rounded-xl border border-border bg-bg-elevated p-4">
          <h3 className="text-[13px] font-medium text-text-primary">{t("settings.localService")}</h3>
          <div className="mt-2 flex items-start gap-2 text-[11px] leading-5 text-text-secondary">
            <Icon name="shieldCheck" size={15} className="mt-0.5 shrink-0 text-success" />
            {t("settings.loopback")}
          </div>
          <code className="mt-3 block break-all rounded bg-bg-main p-2 text-[10px] text-text-tertiary">
            {config?.configFile}
          </code>
          <p className="mt-3 text-[11px] leading-5 text-text-tertiary">{t("settings.offlineHint")}</p>
        </section>
      </aside>
    </div>
  );
}

function Credential({ label, configured }: { label: string; configured: boolean }) {
  const { t } = useTranslation("superagent");
  return (
    <div className="mt-2 flex items-center justify-between text-[11px] text-text-secondary">
      <span>{label}</span>
      <span className={configured ? "text-success" : "text-text-tertiary"}>
        {configured ? t("settings.configured") : t("settings.notConfigured")}
      </span>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  mono?: boolean;
}) {
  return (
    <label className="block text-[11px] text-text-secondary">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`form-control mt-1 w-full rounded-lg border border-border bg-bg-main px-3 py-2 text-[12px] ${mono ? "font-mono" : ""}`}
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min: string;
  max?: string;
}) {
  return (
    <label className="block text-[11px] text-text-secondary">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="form-control mt-1 w-full rounded-lg border border-border bg-bg-main px-3 py-2 text-[12px]"
      />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  rows,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
  mono?: boolean;
}) {
  return (
    <label className="mt-4 block text-[11px] text-text-secondary">
      {label}
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        className={`form-control mt-1 w-full resize-y rounded-lg border border-border bg-bg-main px-3 py-2 text-[12px] leading-5 ${mono ? "font-mono" : ""}`}
      />
    </label>
  );
}
