import { useStore } from "../store";

export function PermissionCard() {
  const pending = useStore((s) => s.pendingPermissions);
  const reply = useStore((s) => s.replyPermission);
  const request = pending[0];
  if (!request) return null;

  const danger = request.risk === "danger";
  const outward = request.risk === "outward";
  const title = danger ? "危险操作，确认执行？" : outward ? "对外动作（影响将推出本机），确认执行？" : "Agent 请求执行操作";
  const headerTone = danger || outward ? "text-danger" : "text-warning";
  const headerBg = danger || outward ? "bg-danger/10" : "bg-warning/10";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[480px] rounded-xl border border-border bg-bg-elevated shadow-2xl">
        <div className={`rounded-t-xl px-4 py-3 ${headerBg}`}>
          <div className={`text-sm font-semibold ${headerTone}`}>{title}</div>
          <div className="mt-0.5 text-xs text-text-tertiary">
            工具：<code className="mono text-text-secondary">{request.toolName}</code>
            {request.sandboxed ? (
              <span data-testid="permission-sandboxed-badge" className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-accent">
                沙盒内
              </span>
            ) : null}
            {pending.length > 1 ? `（还有 ${pending.length - 1} 个待确认）` : ""}
          </div>
        </div>
        <pre className="max-h-56 overflow-auto px-4 py-3 text-xs leading-5 text-text-secondary">
          {formatArgs(request.args)}
        </pre>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={() => reply(request.requestId, false)}
            className="rounded-md border border-border px-4 py-1.5 text-xs text-text-secondary hover:bg-bg-hover"
          >
            拒绝
          </button>
          <button
            type="button"
            onClick={() => reply(request.requestId, true)}
            className={`rounded-md px-4 py-1.5 text-xs font-medium ${
              danger || outward ? "bg-danger text-white hover:bg-danger/80" : "bg-accent text-bg-root hover:bg-accent-dim"
            }`}
          >
            允许执行
          </button>
        </div>
      </div>
    </div>
  );
}

function formatArgs(args: unknown): string {
  if (args && typeof args === "object" && "command" in args) {
    return String((args as { command: unknown }).command);
  }
  try {
    return JSON.stringify(args, null, 2).slice(0, 1500);
  } catch {
    return String(args);
  }
}
