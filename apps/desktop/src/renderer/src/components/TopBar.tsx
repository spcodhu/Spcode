import { baseName } from "@spcode/shared";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import { Icon } from "./Icon";

export function TopBar() {
  const { t } = useTranslation("chat");
  const session = useStore((s) => (s.activeSessionId ? s.sessions[s.activeSessionId] : undefined));

  return (
    <header className="titlebar-drag flex h-12 shrink-0 items-center gap-2 border-b border-border bg-bg-main px-4">
      {session ? (
        <>
          {/* 面包屑：空间/模式 > 会话标题 */}
          <nav
            aria-label={t("topbar.breadcrumb")}
            className="titlebar-no-drag flex min-w-0 items-center gap-1.5 text-[13px]"
          >
            <span className="flex shrink-0 items-center gap-1.5 text-text-secondary">
              <Icon name={session.meta.mode === "project" ? "folder" : "chat"} size={14} />
              {session.meta.mode === "project" ? baseName(session.meta.cwd) || t("topbar.project") : t("topbar.chat")}
            </span>
            <Icon name="chevronRight" size={12} className="shrink-0 text-text-tertiary" />
            <span className="min-w-0 truncate text-text-primary">{session.meta.title}</span>
          </nav>
          <div className="flex-1" />
          <UsageChip />
        </>
      ) : (
        <div className="flex-1" />
      )}
    </header>
  );
}

function UsageChip() {
  const { t } = useTranslation("chat");
  const session = useStore((s) => (s.activeSessionId ? s.sessions[s.activeSessionId] : undefined));
  if (!session) return null;
  const u = session.usage;
  const loading = session.usageLoaded === false;
  const unpriced = (u.unpricedCount ?? 0) > 0;
  const totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
  const cacheHitRate = u.input + u.cacheRead > 0 ? Math.round((u.cacheRead / (u.input + u.cacheRead)) * 100) : 0;
  const cost = loading ? "…" : unpriced ? "$—" : `$${u.costTotal.toFixed(4)}`;
  return (
    <div
      data-testid="session-usage-chip"
      title={t("topbar.usage", {
        input: u.input.toLocaleString(),
        output: u.output.toLocaleString(),
        cache: u.cacheRead.toLocaleString(),
        cacheWrite: u.cacheWrite.toLocaleString(),
        cost: unpriced ? t("topbar.unpriced") : cost,
      })}
      className="titlebar-no-drag flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-bg-elevated px-2.5 py-1 text-[11px] text-text-tertiary"
    >
      <Icon name="chart" size={12} />
      <span>{formatTokens(totalTokens)}</span>
      <span className="text-accent">{t("topbar.cacheRate", { percent: cacheHitRate })}</span>
      <span>{cost}</span>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
