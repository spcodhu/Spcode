import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getControlClient } from "../control";
import { Icon } from "./Icon";

export function SuperAgentOperations() {
  const { t } = useTranslation("superagent");
  const client = getControlClient();
  const [nodes, setNodes] = useState<Array<Record<string, unknown>>>([]);
  const [effects, setEffects] = useState<Array<Record<string, unknown>>>([]);
  const [links, setLinks] = useState<Array<Record<string, unknown>>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [nextNodes, nextEffects, nextLinks] = await Promise.all([
        client.workerNodes(),
        client.effects(),
        client.shareLinks(),
      ]);
      setNodes(nextNodes);
      setEffects(nextEffects);
      setLinks(nextLinks);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const recover = async () => {
    setBusy(true);
    try {
      await client.recoverWorkers();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 space-y-5" data-testid="superagent-operations">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[15px] font-medium text-text-primary">{t("operations.title")}</h2>
          <p className="mt-1 text-[11px] text-text-tertiary">{t("operations.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-lg border border-border px-3 py-2 text-[11px] text-text-secondary hover:bg-bg-hover"
          >
            <Icon name="refresh" size={13} className="mr-1 inline" />
            {t("refresh")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void recover()}
            className="rounded-lg bg-accent px-3 py-2 text-[11px] text-on-accent disabled:opacity-40"
            data-testid="recover-workers"
          >
            {t("operations.recover")}
          </button>
        </div>
      </div>
      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[11px] text-danger" role="alert">
          {error}
        </div>
      )}
      <div className="grid gap-5 xl:grid-cols-2">
        <section className="rounded-xl border border-border bg-bg-elevated">
          <header className="border-b border-border px-4 py-3 text-[13px] font-medium text-text-primary">
            {t("operations.nodes", { count: nodes.length })}
          </header>
          <div className="divide-y divide-border">
            {nodes.length === 0 ? (
              <p className="px-4 py-6 text-[12px] text-text-tertiary">{t("operations.noNodes")}</p>
            ) : (
              nodes.map((node) => (
                <div key={String(node.id)} className="px-4 py-3 text-[11px]">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-full ${node.status === "ACTIVE" ? "bg-success" : node.status === "REVOKED" ? "bg-danger" : "bg-warning"}`}
                    />
                    <span className="font-medium text-text-primary">{String(node.name)}</span>
                    <span className="ml-auto text-text-tertiary">{String(node.status)}</span>
                  </div>
                  <div className="mt-1 break-all font-mono text-[10px] text-text-tertiary">{String(node.id)}</div>
                  <div className="mt-1 text-text-tertiary">
                    {t("operations.heartbeat", {
                      time: node.last_heartbeat_at ? new Date(Number(node.last_heartbeat_at)).toLocaleString() : "-",
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
        <section className="rounded-xl border border-border bg-bg-elevated">
          <header className="border-b border-border px-4 py-3 text-[13px] font-medium text-text-primary">
            {t("operations.effects", { count: effects.length })}
          </header>
          <div className="max-h-[420px] divide-y divide-border overflow-y-auto">
            {effects.length === 0 ? (
              <p className="px-4 py-6 text-[12px] text-text-tertiary">{t("operations.noEffects")}</p>
            ) : (
              effects.map((effect) => (
                <div key={String(effect.id)} className="px-4 py-3 text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-text-primary">{String(effect.type)}</span>
                    <span className="ml-auto rounded bg-bg-hover px-2 py-0.5 text-[10px] text-text-secondary">
                      {String(effect.status)}
                    </span>
                  </div>
                  <div className="mt-1 break-all text-text-secondary">{String(effect.resource)}</div>
                  <div className="mt-1 font-mono text-[10px] text-text-tertiary">
                    {t("operations.fence", { value: effect.fence })} · {String(effect.externalId ?? "-")}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
      <section className="rounded-xl border border-border bg-bg-elevated">
        <header className="border-b border-border px-4 py-3 text-[13px] font-medium text-text-primary">
          {t("operations.links", { count: links.length })}
        </header>
        <div className="divide-y divide-border">
          {links.length === 0 ? (
            <p className="px-4 py-6 text-[12px] text-text-tertiary">{t("operations.noLinks")}</p>
          ) : (
            links.map((link) => (
              <div key={String(link.id)} className="flex flex-wrap items-center gap-2 px-4 py-3 text-[11px]">
                <code className="text-text-secondary">{String(link.id)}</code>
                <span className={link.revokedAt ? "text-danger" : "text-text-tertiary"}>
                  {link.revokedAt
                    ? t("operations.revoked")
                    : t("operations.expires", { time: new Date(Number(link.expiresAt)).toLocaleString() })}
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
