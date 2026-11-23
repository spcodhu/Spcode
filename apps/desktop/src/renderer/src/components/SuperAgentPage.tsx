import { ControlApiError } from "@spcode/shared/control-client";
import type {
  SuperAgentCommand,
  SuperAgentPublicConfig,
  SuperAgentSnapshot,
  WorkItem,
  WorkItemState,
} from "@spcode/shared/superagent";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getControlClient, subscribeControlEvents } from "../control";
import { Icon } from "./Icon";
import { SuperAgentDigest } from "./SuperAgentDigest";
import { SuperAgentSettings } from "./SuperAgentSettings";

export function SuperAgentPage() {
  const { t } = useTranslation("superagent");
  const client = getControlClient();
  const [snapshot, setSnapshot] = useState<SuperAgentSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [repo, setRepo] = useState("spcodhu/Spcode");
  const [title, setTitle] = useState("");
  const [request, setRequest] = useState("");
  const [planContent, setPlanContent] = useState("");
  const [baseSha, setBaseSha] = useState("");
  const [verification, setVerification] = useState("pnpm lint && pnpm typecheck && pnpm test");
  const [changeScope, setChangeScope] = useState("");
  const [tab, setTab] = useState<"work" | "digest" | "settings">("work");
  const [config, setConfig] = useState<SuperAgentPublicConfig | null>(null);
  const [events, setEvents] = useState<
    Array<{ id: number; seq: number; type: string; payload: unknown; createdAt: number }>
  >([]);

  const refresh = useCallback(async () => {
    try {
      const [next, nextConfig] = await Promise.all([client.superAgentSnapshot(), client.superAgentConfig()]);
      setSnapshot(next);
      setConfig(nextConfig);
      setSelectedId((current) => current ?? next.workItems[0]?.id ?? null);
      setError("");
      setAuthRequired(false);
    } catch (cause) {
      if (cause instanceof ControlApiError && cause.status === 401) setAuthRequired(true);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    return subscribeControlEvents((event) => {
      if (event.type === "superagent.changed" || event.type === "desktop.status" || event.type === "control.hello") {
        void refresh();
      }
    });
  }, [refresh]);

  const selected = snapshot?.workItems.find((item) => item.id === selectedId) ?? null;
  const selectedPlan = snapshot?.plans.find((plan) => plan.id === selected?.currentPlanId) ?? null;
  useEffect(() => {
    let alive = true;
    setEvents([]);
    if (!selectedId) return;
    void client
      .workItemEvents(selectedId)
      .then((next) => {
        if (alive) setEvents(next);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client, selectedId]);
  const selectedAttempts = snapshot?.attempts.filter((attempt) => attempt.workItemId === selectedId) ?? [];
  const selectedAudit = snapshot?.audit.filter((entry) => entry.workItemId === selectedId) ?? [];
  const counts = useMemo(
    () => ({
      attention: snapshot?.workItems.filter((item) =>
        ["AWAITING_PLAN_APPROVAL", "AWAITING_RECONCILIATION", "BLOCKED", "FAILED"].includes(item.status),
      ).length,
      active: snapshot?.workItems.filter((item) =>
        ["QUEUED", "RUNNING", "VALIDATING", "COMMITTING"].includes(item.status),
      ).length,
    }),
    [snapshot],
  );

  const execute = async (command: SuperAgentCommand) => {
    setBusy(true);
    try {
      const next = await client.superAgentCommand(command);
      setSnapshot(next);
      if (command.type === "workitem.create") {
        setSelectedId(next.workItems.find((item) => item.title === title)?.id ?? next.workItems[0]?.id ?? null);
        setTitle("");
        setRequest("");
      }
      if (command.type === "plan.submit") setPlanContent("");
      if (command.type === "config.update") await refresh();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const authenticate = async () => {
    setBusy(true);
    try {
      await client.bootstrap(token.trim());
      setToken("");
      setAuthRequired(false);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="h-full overflow-y-auto bg-bg-main" data-testid="superagent-page">
      <div className="mx-auto max-w-[1180px] px-8 py-7">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-[0.16em] text-text-tertiary">
              <Icon name="cpu" size={15} /> {t("eyebrow")}
            </div>
            <h1 className="mt-2 text-[26px] font-semibold tracking-tight text-text-primary">{t("title")}</h1>
            <p className="mt-1 text-[13px] text-text-secondary">{t("subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              className="flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-[12px] text-text-secondary hover:bg-bg-hover"
            >
              <Icon name="refresh" size={14} /> {t("refresh")}
            </button>
            {window.spcode.isDesktop && window.spcode.openWorkbench && (
              <button
                type="button"
                onClick={() => void window.spcode.openWorkbench?.()}
                className="flex h-9 items-center gap-2 rounded-lg bg-accent px-3 text-[12px] text-on-accent"
                data-testid="open-workbench-browser"
              >
                <Icon name="globe" size={14} /> {t("openBrowser")}
              </button>
            )}
          </div>
        </header>

        {authRequired && (
          <section className="mt-6 rounded-xl border border-warning bg-bg-elevated p-5" role="alert">
            <h2 className="font-medium text-text-primary">{t("authTitle")}</h2>
            <p className="mt-1 text-[12px] leading-5 text-text-secondary">{t("authDescription")}</p>
            <div className="mt-3 flex gap-2">
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                type="password"
                aria-label={t("authToken")}
                placeholder={t("authToken")}
                className="form-control min-w-0 flex-1 rounded-lg border border-border bg-bg-main px-3 py-2 text-[13px]"
              />
              <button
                type="button"
                disabled={!token.trim() || busy}
                onClick={() => void authenticate()}
                className="rounded-lg bg-accent px-4 text-on-accent disabled:opacity-50"
              >
                {t("authenticate")}
              </button>
            </div>
          </section>
        )}

        {error && !authRequired && (
          <div
            className="mt-5 flex items-start justify-between gap-4 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-[12px] text-danger"
            role="alert"
          >
            <span>{error}</span>
            <button type="button" onClick={() => setError("")} aria-label={t("closeError")}>
              <Icon name="x" size={14} />
            </button>
          </div>
        )}

        <section className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4" aria-label={t("serviceStatus")}>
          <Metric label={t("attention")} value={counts.attention ?? 0} tone={counts.attention ? "warning" : "normal"} />
          <Metric label={t("active")} value={counts.active ?? 0} />
          <Metric
            label={t("desktopAdapter")}
            value={snapshot?.service.desktopConnected ? t("connected") : t("disconnected")}
          />
          <Metric
            label={t("dispatchState")}
            value={snapshot?.service.processingPaused ? t("paused") : t("runningNormally")}
          />
        </section>

        <nav className="mt-5 flex gap-1 rounded-lg bg-bg-sidebar p-1" aria-label={t("tabs.label")}>
          {(["work", "digest", "settings"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              className={`rounded-md px-4 py-2 text-[12px] ${tab === item ? "bg-bg-elevated text-text-primary shadow-sm" : "text-text-secondary"}`}
              data-testid={`superagent-tab-${item}`}
            >
              {t(`tabs.${item}`)}
            </button>
          ))}
        </nav>

        {tab === "work" && (
          <div className="mt-6 grid min-h-[520px] gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
            <div className="space-y-5">
              <section className="rounded-xl border border-border bg-bg-elevated p-4">
                <h2 className="text-[13px] font-medium text-text-primary">{t("createTitle")}</h2>
                <p className="mt-1 text-[11px] leading-5 text-text-tertiary">{t("createDescription")}</p>
                <div className="mt-3 space-y-3">
                  <Field label={t("repo")} value={repo} onChange={setRepo} />
                  <Field
                    label={t("workItemTitle")}
                    value={title}
                    onChange={setTitle}
                    placeholder={t("titlePlaceholder")}
                  />
                  <label className="block text-[11px] text-text-secondary">
                    {t("request")}
                    <textarea
                      value={request}
                      onChange={(event) => setRequest(event.target.value)}
                      rows={4}
                      placeholder={t("requestPlaceholder")}
                      className="form-control mt-1 w-full resize-none rounded-lg border border-border bg-bg-main px-3 py-2 text-[12px] leading-5 text-text-primary"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy || !title.trim() || !request.trim() || !repo.trim()}
                    onClick={() =>
                      void execute({
                        type: "workitem.create",
                        requestId: crypto.randomUUID(),
                        repo: repo.trim(),
                        title: title.trim(),
                        request: request.trim(),
                      })
                    }
                    className="w-full rounded-lg bg-accent py-2 text-[12px] text-on-accent disabled:opacity-40"
                    data-testid="create-workitem"
                  >
                    {t("create")}
                  </button>
                </div>
              </section>

              <section className="overflow-hidden rounded-xl border border-border bg-bg-elevated">
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                  <h2 className="text-[13px] font-medium text-text-primary">{t("workItems")}</h2>
                  <span className="text-[11px] text-text-tertiary">
                    {t("revision", { revision: snapshot?.revision ?? 0 })}
                  </span>
                </div>
                <div className="max-h-[360px] overflow-y-auto p-2">
                  {snapshot?.workItems.length ? (
                    snapshot.workItems.map((item) => (
                      <WorkItemRow
                        key={item.id}
                        item={item}
                        active={selectedId === item.id}
                        onClick={() => setSelectedId(item.id)}
                      />
                    ))
                  ) : (
                    <div className="px-3 py-10 text-center text-[12px] text-text-tertiary">{t("empty")}</div>
                  )}
                </div>
              </section>
            </div>

            <section className="min-w-0 rounded-xl border border-border bg-bg-elevated">
              {selected ? (
                <div className="flex h-full flex-col">
                  <div className="border-b border-border px-5 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge state={selected.status} />
                      <span className="text-[11px] text-text-tertiary">{selected.repo}</span>
                      <span className="ml-auto font-mono text-[10px] text-text-tertiary">{selected.id}</span>
                    </div>
                    <h2 className="mt-2 text-[18px] font-medium text-text-primary">{selected.title}</h2>
                    <p className="mt-2 whitespace-pre-wrap text-[12px] leading-6 text-text-secondary">
                      {selected.request}
                    </p>
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto p-5">
                    {(selected.status === "PLANNING" || selected.status === "AWAITING_PLAN_APPROVAL") && (
                      <div className="rounded-lg border border-border bg-bg-main p-4">
                        <h3 className="text-[13px] font-medium text-text-primary">
                          {selectedPlan ? t("submitRevision", { revision: selectedPlan.revision }) : t("submitPlan")}
                        </h3>
                        <p className="mt-1 text-[11px] leading-5 text-text-tertiary">{t("planEntryDescription")}</p>
                        <textarea
                          aria-label={t("planContent")}
                          value={planContent}
                          onChange={(event) => setPlanContent(event.target.value)}
                          rows={7}
                          placeholder={t("planPlaceholder")}
                          className="form-control mt-3 w-full resize-y rounded-lg border border-border bg-bg-elevated p-3 font-mono text-[12px] leading-5"
                        />
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          <Field
                            label={t("baseSha")}
                            value={baseSha}
                            onChange={setBaseSha}
                            placeholder={t("baseShaPlaceholder")}
                            mono
                          />
                          <Field
                            label={t("changeScope")}
                            value={changeScope}
                            onChange={setChangeScope}
                            placeholder={t("scopePlaceholder")}
                          />
                        </div>
                        <label className="mt-3 block text-[11px] text-text-secondary">
                          {t("verification")}
                          <textarea
                            value={verification}
                            onChange={(event) => setVerification(event.target.value)}
                            rows={2}
                            className="form-control mt-1 w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 font-mono text-[11px]"
                          />
                        </label>
                        <button
                          type="button"
                          disabled={busy || !planContent.trim() || !baseSha.trim()}
                          onClick={() =>
                            void execute({
                              type: "plan.submit",
                              workItemId: selected.id,
                              content: planContent.trim(),
                              baseSha: baseSha.trim(),
                              verification: verification
                                .split("\n")
                                .map((line) => line.trim())
                                .filter(Boolean),
                              changeScope: changeScope
                                .split(",")
                                .map((part) => part.trim())
                                .filter(Boolean),
                            })
                          }
                          className="mt-3 rounded-lg bg-accent px-4 py-2 text-[12px] text-on-accent disabled:opacity-40"
                          data-testid="submit-plan"
                        >
                          {t("savePlan")}
                        </button>
                      </div>
                    )}

                    {selectedPlan && (
                      <article className="mt-5">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-[13px] font-medium text-text-primary">
                            {t("planVersion", { revision: selectedPlan.revision })}
                          </h3>
                          <span className="rounded bg-bg-hover px-2 py-0.5 text-[10px] text-text-secondary">
                            {selectedPlan.status}
                          </span>
                          <code className="text-[10px] text-text-tertiary">{selectedPlan.planHash.slice(0, 12)}</code>
                        </div>
                        <div className="mt-2 grid gap-2 text-[11px] text-text-secondary sm:grid-cols-2">
                          <div>
                            {t("baseline")} <code>{selectedPlan.baseSha}</code>
                          </div>
                          <div>
                            {t("publishIntent")} {selectedPlan.publishIntent ? t("publishYes") : t("publishNo")}
                          </div>
                        </div>
                        <pre className="mt-3 max-h-[360px] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-bg-main p-4 font-mono text-[11px] leading-6 text-text-secondary">
                          {selectedPlan.content}
                        </pre>
                        {selectedPlan.status === "PENDING" && selected.status === "AWAITING_PLAN_APPROVAL" && (
                          <div className="mt-3 flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/5 p-3">
                            <div className="min-w-0 flex-1 text-[11px] leading-5 text-text-secondary">
                              {t("approvalDescription")}
                            </div>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void execute({
                                  type: "plan.approve",
                                  workItemId: selected.id,
                                  planId: selectedPlan.id,
                                  planHash: selectedPlan.planHash,
                                })
                              }
                              className="shrink-0 rounded-lg bg-accent px-4 py-2 text-[12px] text-on-accent"
                              data-testid="approve-plan"
                            >
                              {t("approve")}
                            </button>
                          </div>
                        )}
                      </article>
                    )}

                    {selectedPlan?.artifactId && (
                      <a
                        href={client.artifactUrl(selectedPlan.artifactId)}
                        className="mt-3 inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
                      >
                        <Icon name="fileText" size={13} /> {t("detail.downloadPlan")}
                      </a>
                    )}

                    {selectedAttempts.length > 0 && (
                      <section className="mt-5 rounded-lg border border-border bg-bg-main p-4">
                        <h3 className="text-[13px] font-medium text-text-primary">{t("detail.attempts")}</h3>
                        <div className="mt-3 space-y-2">
                          {selectedAttempts.map((attempt) => (
                            <div
                              key={attempt.id}
                              className="rounded border border-border px-3 py-2 text-[11px] text-text-secondary"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="rounded bg-bg-hover px-2 py-0.5">{attempt.role}</span>
                                <span>{attempt.status}</span>
                                <span>{t("detail.fence", { value: attempt.fence })}</span>
                                {attempt.logArtifactId && (
                                  <a
                                    href={client.artifactUrl(attempt.logArtifactId)}
                                    className="ml-auto text-accent hover:underline"
                                  >
                                    {t("detail.log")}
                                  </a>
                                )}
                              </div>
                              <code className="mt-1 block text-[10px] text-text-tertiary">{attempt.id}</code>
                            </div>
                          ))}
                        </div>
                      </section>
                    )}

                    {selected.commitSha && (
                      <section className="mt-5 rounded-lg border border-success/30 bg-success/5 p-4">
                        <h3 className="text-[13px] font-medium text-text-primary">{t("detail.completed")}</h3>
                        <div className="mt-2 text-[11px] text-text-secondary">
                          {t("detail.commit")} <code>{selected.commitSha}</code>
                        </div>
                        {selected.report?.tests.map((test) => (
                          <div
                            key={test.command}
                            className="mt-2 rounded border border-border bg-bg-main px-3 py-2 text-[11px]"
                          >
                            <div className={test.status === "passed" ? "text-success" : "text-danger"}>
                              {t("detail.exit", { status: test.status, code: test.exitCode ?? "-" })}
                            </div>
                            <code className="mt-1 block break-all text-text-secondary">{test.command}</code>
                          </div>
                        ))}
                        {selected.diffArtifactId && (
                          <a
                            href={client.artifactUrl(selected.diffArtifactId)}
                            className="mt-3 inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
                          >
                            <Icon name="fileText" size={13} /> {t("detail.downloadDiff")}
                          </a>
                        )}
                      </section>
                    )}

                    {selected.diff?.patch && (
                      <details className="mt-4 rounded-lg border border-border bg-bg-main p-3">
                        <summary className="cursor-pointer text-[12px] text-text-secondary">{t("detail.diff")}</summary>
                        <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-5 text-text-secondary">
                          {selected.diff.patch}
                        </pre>
                      </details>
                    )}

                    {selected.lastError && (
                      <div className="mt-4 rounded-lg border border-danger/30 bg-danger/5 p-3 text-[11px] leading-5 text-danger">
                        {selected.lastError}
                      </div>
                    )}

                    {events.length > 0 && (
                      <details className="mt-4 rounded-lg border border-border bg-bg-main p-3">
                        <summary className="cursor-pointer text-[12px] text-text-secondary">
                          {t("detail.activity", { count: events.length })}
                        </summary>
                        <div className="mt-3 space-y-2">
                          {events.slice(0, 30).map((event) => (
                            <div
                              key={event.id}
                              className="rounded border border-border px-3 py-2 text-[10px] text-text-secondary"
                            >
                              <div>{t("detail.seq", { seq: event.seq, type: event.type })}</div>
                              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all">
                                {JSON.stringify(event.payload).slice(0, 600)}
                              </pre>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    {selectedAudit.length > 0 && (
                      <details className="mt-4 rounded-lg border border-border bg-bg-main p-3">
                        <summary className="cursor-pointer text-[12px] text-text-secondary">
                          {t("detail.audit", { count: selectedAudit.length })}
                        </summary>
                        <div className="mt-3 space-y-1 text-[10px] text-text-secondary">
                          {selectedAudit.slice(0, 50).map((entry) => (
                            <div key={entry.id} className="border-b border-border pb-1 last:border-0">
                              {new Date(entry.createdAt).toLocaleString()} · {entry.actorId} · {entry.action}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    {selected.status === "QUEUED" && (
                      <div className="mt-5 rounded-lg border border-border bg-bg-main p-4 text-[12px] leading-6 text-text-secondary">
                        <strong className="text-text-primary">{t("persisted")}</strong>{" "}
                        {snapshot?.enabled ? t("queuedDescription") : t("queuedDisabled")}
                      </div>
                    )}

                    <div className="mt-6 flex gap-2 border-t border-border pt-4">
                      <button
                        type="button"
                        onClick={() =>
                          void execute({ type: "processing.setPaused", paused: !snapshot?.service.processingPaused })
                        }
                        className="rounded-lg border border-border px-3 py-1.5 text-[11px] text-text-secondary hover:bg-bg-hover"
                      >
                        {snapshot?.service.processingPaused ? t("resume") : t("pause")}
                      </button>
                      {selected.status !== "CANCELLED" && selected.status !== "COMPLETED" && (
                        <button
                          type="button"
                          onClick={() => void execute({ type: "workitem.cancel", workItemId: selected.id })}
                          className="rounded-lg border border-danger/30 px-3 py-1.5 text-[11px] text-danger hover:bg-danger/5"
                        >
                          {t("stop")}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex h-full min-h-[420px] items-center justify-center p-8 text-center">
                  <div>
                    <Icon name="inbox" size={30} className="mx-auto text-text-tertiary" />
                    <p className="mt-3 text-[13px] text-text-secondary">{t("emptyDetail")}</p>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
        {tab === "digest" && (
          <SuperAgentDigest snapshot={snapshot} repo={repo} onRepoChange={setRepo} busy={busy} execute={execute} />
        )}
        {tab === "settings" && <SuperAgentSettings config={config} busy={busy} execute={execute} />}
      </div>
    </main>
  );
}

function Metric({
  label,
  value,
  tone = "normal",
}: {
  label: string;
  value: string | number;
  tone?: "normal" | "warning";
}) {
  return (
    <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3">
      <div className="text-[11px] text-text-tertiary">{label}</div>
      <div className={`mt-1 text-[18px] font-medium ${tone === "warning" ? "text-warning" : "text-text-primary"}`}>
        {value}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <label className="block text-[11px] text-text-secondary">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={`form-control mt-1 w-full rounded-lg border border-border bg-bg-main px-3 py-2 text-[12px] text-text-primary ${mono ? "font-mono" : ""}`}
      />
    </label>
  );
}

function StatusBadge({ state }: { state: WorkItemState }) {
  const { t } = useTranslation("superagent");
  const attention = ["AWAITING_PLAN_APPROVAL", "AWAITING_RECONCILIATION", "BLOCKED", "FAILED"].includes(state);
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-[10px] font-medium ${
        attention
          ? "bg-warning/10 text-warning"
          : state === "COMPLETED"
            ? "bg-success/10 text-success"
            : "bg-bg-hover text-text-secondary"
      }`}
    >
      {t(`state.${state}`)}
    </span>
  );
}

function WorkItemRow({ item, active, onClick }: { item: WorkItem; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-1 w-full rounded-lg px-3 py-3 text-left ${active ? "bg-bg-active" : "hover:bg-bg-hover"}`}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-primary">{item.title}</span>
        <StatusBadge state={item.status} />
      </div>
      <div className="mt-1 truncate text-[10px] text-text-tertiary">{item.repo}</div>
    </button>
  );
}
