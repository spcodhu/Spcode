import { useStore } from "../store";
import type { ModelRef } from "@spcode/shared";

export function TopBar() {
  const activeSessionId = useStore((s) => s.activeSessionId);
  const session = useStore((s) => (s.activeSessionId ? s.sessions[s.activeSessionId] : undefined));
  const models = useStore((s) => s.models);
  const settings = useStore((s) => s.settings);
  const setModel = useStore((s) => s.setModel);
  const setThinkingLevel = useStore((s) => s.setThinkingLevel);
  const saveSettings = useStore((s) => s.saveSettings);

  const modelValue = session?.meta.model
    ? `${session.meta.model.provider}/${session.meta.model.modelId}`
    : "";

  return (
    <header className="titlebar-drag flex h-12 shrink-0 items-center gap-3 border-b border-border bg-bg-main px-4 pl-20">
      {activeSessionId && session ? (
        <div className="titlebar-no-drag flex min-w-0 flex-1 items-center gap-2">
          {/* 模型选择 */}
          <select
            value={modelValue}
            onChange={(e) => {
              const [provider, ...rest] = e.target.value.split("/");
              if (provider && rest.length) {
                void setModel({ provider, modelId: rest.join("/") } as ModelRef);
              }
            }}
            className="max-w-56 truncate rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-text-primary outline-none"
          >
            {models.length === 0 && <option value="">未配置模型（去设置里填 API Key）</option>}
            {models.map((m) => (
              <option key={`${m.provider}/${m.modelId}`} value={`${m.provider}/${m.modelId}`}>
                {m.provider} · {m.displayName}
              </option>
            ))}
          </select>

          {/* 思考强度 */}
          {session.supportedThinkingLevels.length > 0 && (
            <select
              value={session.meta.thinkingLevel}
              onChange={(e) => void setThinkingLevel(e.target.value)}
              title="思考强度（实际下发到厂商 API）"
              className="rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-text-secondary outline-none"
            >
              {session.supportedThinkingLevels.map((lv) => (
                <option key={lv} value={lv}>
                  思考 · {lv}
                </option>
              ))}
            </select>
          )}

          {/* 权限模式 */}
          <button
            onClick={() =>
              void saveSettings({ permissionMode: settings?.permissionMode === "ask" ? "act" : "ask" })
            }
            title="ask=每次确认；act=自动放行（危险命令仍确认）"
            className={`rounded-md border px-2 py-1 text-xs ${
              settings?.permissionMode === "act"
                ? "border-warning/50 bg-warning/10 text-warning"
                : "border-border bg-bg-elevated text-text-secondary"
            }`}
          >
            {settings?.permissionMode === "act" ? "⚡ 行动模式" : "🛡 询问模式"}
          </button>

          <div className="flex-1" />

          {/* 用量摘要 */}
          <UsageChip />
        </div>
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
      className="flex items-center gap-1.5 rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-text-tertiary"
    >
      <span>{formatTokens(totalTokens)} tok</span>
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
