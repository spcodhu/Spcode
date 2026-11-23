import type { SuperAgentCommand, SuperAgentSnapshot } from "@spcode/shared/superagent";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";

export function SuperAgentDigest({
  snapshot,
  repo,
  onRepoChange,
  busy,
  execute,
}: {
  snapshot: SuperAgentSnapshot | null;
  repo: string;
  onRepoChange: (repo: string) => void;
  busy: boolean;
  execute: (command: SuperAgentCommand) => Promise<void>;
}) {
  const { t } = useTranslation("superagent");
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  return (
    <div className="mt-6 space-y-5">
      <section className="rounded-xl border border-border bg-bg-elevated p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[260px] flex-1 text-[11px] text-text-secondary">
            {t("repo")}
            <input
              value={repo}
              onChange={(event) => onRepoChange(event.target.value)}
              className="form-control mt-1 w-full rounded-lg border border-border bg-bg-main px-3 py-2 font-mono text-[12px]"
            />
          </label>
          <button
            type="button"
            disabled={busy || !repo.trim()}
            onClick={() => void execute({ type: "digest.run", repo: repo.trim(), requestId: crypto.randomUUID() })}
            className="rounded-lg bg-accent px-4 py-2 text-[12px] text-on-accent disabled:opacity-40"
            data-testid="run-digest"
          >
            <Icon name="refresh" size={14} className="mr-1 inline" /> {t("digest.run")}
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-5 text-text-tertiary">{t("digest.manualHint")}</p>
      </section>

      {(snapshot?.digests?.length ?? 0) === 0 ? (
        <div className="rounded-xl border border-border bg-bg-elevated px-4 py-12 text-center text-[12px] text-text-tertiary">
          {t("digest.empty")}
        </div>
      ) : (
        snapshot?.digests?.map((digest) => (
          <section key={digest.id} className="overflow-hidden rounded-xl border border-border bg-bg-elevated">
            <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
              <h2 className="text-[13px] font-medium text-text-primary">{digest.repo}</h2>
              <span className="text-[11px] text-text-tertiary">{digest.localDate}</span>
              <code className="ml-auto text-[10px] text-text-tertiary">{digest.digestHash.slice(0, 12)}</code>
            </header>
            <div className="divide-y divide-border">
              {digest.items.length === 0 ? (
                <p className="px-4 py-5 text-[12px] text-text-tertiary">{t("digest.noIncrement")}</p>
              ) : (
                digest.items.map((item) => (
                  <article key={item.itemId} className="px-4 py-4">
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[13px] font-medium text-accent hover:underline"
                        >
                          #{item.number} {item.title}
                        </a>
                        <p className="mt-1 text-[11px] text-text-tertiary">
                          {item.author} · {item.labels.join(", ") || t("digest.noLabels")} · {item.updatedAt}
                        </p>
                        <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[12px] leading-5 text-text-secondary">
                          {item.body}
                        </p>
                      </div>
                      {item.resolution ? (
                        <span className="rounded-full bg-bg-hover px-2.5 py-1 text-[10px] text-text-secondary">
                          {item.resolution === "APPROVED" ? t("digest.approved") : t("digest.ignored")}
                        </span>
                      ) : (
                        <div className="flex shrink-0 gap-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void execute({
                                type: "digest.resolve",
                                digestId: digest.id,
                                itemId: item.itemId,
                                digestHash: digest.digestHash,
                                action: "approve",
                              })
                            }
                            className="rounded-lg bg-accent px-3 py-1.5 text-[11px] text-on-accent"
                            data-testid={`approve-issue-${item.number}`}
                          >
                            {t("digest.trigger")}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void execute({
                                type: "digest.resolve",
                                digestId: digest.id,
                                itemId: item.itemId,
                                digestHash: digest.digestHash,
                                action: "ignore",
                              })
                            }
                            className="rounded-lg border border-border px-3 py-1.5 text-[11px] text-text-secondary"
                          >
                            {t("digest.ignore")}
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
        ))
      )}

      {(snapshot?.outbox?.filter((item) => item.status === "UNKNOWN").length ?? 0) > 0 && (
        <section className="rounded-xl border border-warning/40 bg-bg-elevated p-4">
          <h2 className="text-[13px] font-medium text-warning">{t("outbox.unknownTitle")}</h2>
          <p className="mt-1 text-[11px] leading-5 text-text-tertiary">{t("outbox.unknownHint")}</p>
          <div className="mt-3 space-y-3">
            {snapshot?.outbox
              ?.filter((item) => item.status === "UNKNOWN")
              .map((item) => (
                <div key={item.id} className="rounded-lg border border-border bg-bg-main p-3">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-secondary">
                    <code>{item.id}</code>
                    <span>{item.kind}</span>
                    <span className="ml-auto">{t("outbox.attempts", { count: item.attemptCount })}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-danger">{item.lastError}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <input
                      value={evidence[item.id] ?? ""}
                      onChange={(event) => setEvidence((current) => ({ ...current, [item.id]: event.target.value }))}
                      placeholder={t("outbox.evidencePlaceholder")}
                      aria-label={t("outbox.evidenceLabel")}
                      className="form-control min-w-[220px] flex-1 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-[11px]"
                    />
                    <button
                      type="button"
                      disabled={busy || !evidence[item.id]?.trim()}
                      onClick={() =>
                        void execute({
                          type: "outbox.reconcile",
                          id: item.id,
                          outcome: "SENT",
                          externalId: evidence[item.id]!.trim(),
                        })
                      }
                      className="rounded-lg bg-accent px-3 py-1.5 text-[11px] text-on-accent disabled:opacity-40"
                    >
                      {t("outbox.confirmSent")}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void execute({ type: "outbox.reconcile", id: item.id, outcome: "FAILED" })}
                      className="rounded-lg border border-danger/30 px-3 py-1.5 text-[11px] text-danger"
                    >
                      {t("outbox.confirmNotSent")}
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </section>
      )}
    </div>
  );
}
