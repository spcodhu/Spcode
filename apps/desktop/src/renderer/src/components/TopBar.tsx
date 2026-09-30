import { baseName } from "@spcode/shared";
import { useStore } from "../store";
import { Icon } from "./Icon";

export function TopBar() {
  const session = useStore((s) => (s.activeSessionId ? s.sessions[s.activeSessionId] : undefined));

  return (
    <header className="titlebar-drag flex h-12 shrink-0 items-center gap-2 border-b border-border bg-bg-main px-4">
      {session ? (
        <>
          {/* 面包屑：空间/模式 > 会话标题 */}
          <nav className="titlebar-no-drag flex min-w-0 items-center gap-1.5 text-[13px]">
            <span className="flex shrink-0 items-center gap-1.5 text-text-secondary">
              <Icon name={session.meta.mode === "project" ? "folder" : "chat"} size={14} />
              {session.meta.mode === "project" ? baseName(session.meta.cwd) || "项目" : "聊天"}
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
  const session = useStore((s) => (s.activeSessionId ? s.sessions[s.activeSessionId] : undefined));
  if (!session || session.usage.count === 0) return null;
  const u = session.usage;
  const totalTokens = u.input + u.output;
  const cacheHitRate = u.input > 0 ? Math.round((u.cacheRead / (u.input + u.cacheRead)) * 100) : 0;
  return (
    <div
      title={`输入 ${u.input.toLocaleString()} · 输出 ${u.output.toLocaleString()} · 缓存命中 ${u.cacheRead.toLocaleString()} · 成本 $${u.costTotal.toFixed(4)}`}
      className="titlebar-no-drag flex items-center gap-1.5 rounded-full border border-border bg-bg-elevated px-2.5 py-1 text-[11px] text-text-tertiary"
    >
      <Icon name="chart" size={12} />
      <span>{formatTokens(totalTokens)}</span>
      <span className="text-accent">缓存 {cacheHitRate}%</span>
      <span>${u.costTotal.toFixed(4)}</span>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
