import { useStore } from "../store";

/**
 * 权限批准卡：拒绝 / 允许 / 总允许（Finch 式规则沉淀）。
 *
 * - 「总允许」：把命令前缀（首条管道段的前两个 token）写入 permissionRules，
 *   以后同类命令免弹窗；逃生舱请求（bypass）额外双写 sandbox.excludedCommands——
 *   以后该命令直接沙盒外执行。danger 级不提供「总允许」（不可逆操作没有免问）。
 * - bypass 请求强警示：命令将以完整权限在沙盒外执行，不受文件/网络边界约束。
 * - 仅 bash/powershell 显示「总允许」（规则只匹配 shell 命令；network 域名询问等不适用）。
 */
export function PermissionCard() {
  const pending = useStore((s) => s.pendingPermissions);
  const reply = useStore((s) => s.replyPermission);
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const request = pending[0];
  if (!request) return null;

  const danger = request.risk === "danger";
  const outward = request.risk === "outward";
  const bypass = request.bypass === true;
  const isShell = request.toolName === "bash" || request.toolName === "powershell";
  const rule = isShell ? deriveRule(request.args) : null;

  const title = bypass
    ? "将在沙盒外执行（不受文件/网络边界约束），确认？"
    : danger
      ? "危险操作，确认执行？"
      : outward
        ? "对外动作（影响将推出本机），确认执行？"
        : "Agent 请求执行操作";
  const severe = danger || outward || bypass;

  const allowAlways = () => {
    if (rule && settings) {
      const rules = settings.permissionRules ?? [];
      const patch: Parameters<typeof saveSettings>[0] = {
        permissionRules: rules.includes(rule) ? rules : [...rules, rule],
      };
      if (bypass) {
        const excluded = settings.sandbox.excludedCommands ?? [];
        patch.sandbox = {
          ...settings.sandbox,
          excludedCommands: excluded.includes(rule) ? excluded : [...excluded, rule],
        };
      }
      void saveSettings(patch);
    }
    reply(request.requestId, true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[480px] rounded-xl border border-border bg-bg-elevated shadow-2xl">
        <div className={`rounded-t-xl px-4 py-3 ${severe ? "bg-danger/10" : "bg-warning/10"}`}>
          <div className={`text-sm font-semibold ${severe ? "text-danger" : "text-warning"}`}>{title}</div>
          <div className="mt-0.5 text-xs text-text-tertiary">
            工具：<code className="mono text-text-secondary">{request.toolName}</code>
            {request.sandboxed ? (
              <span
                data-testid="permission-sandboxed-badge"
                className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-accent"
              >
                沙盒内
              </span>
            ) : null}
            {bypass ? (
              <span
                data-testid="permission-bypass-badge"
                className="ml-2 rounded bg-danger/15 px-1.5 py-0.5 text-danger"
              >
                沙盒外
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
            data-testid="permission-deny"
            onClick={() => reply(request.requestId, false)}
            className="rounded-md border border-border px-4 py-1.5 text-xs text-text-secondary hover:bg-bg-hover"
          >
            拒绝
          </button>
          {!danger && rule && (
            <button
              type="button"
              data-testid="permission-allow-always"
              onClick={allowAlways}
              title={`以后「${rule} …」开头的命令不再询问${bypass ? "，并加入沙盒外白名单" : ""}（可在设置里移除）`}
              className="rounded-md border border-border px-4 py-1.5 text-xs text-text-secondary hover:bg-bg-hover"
            >
              总允许
            </button>
          )}
          <button
            type="button"
            data-testid="permission-allow"
            onClick={() => reply(request.requestId, true)}
            className={`rounded-md px-4 py-1.5 text-xs font-medium ${
              severe ? "bg-danger text-white hover:bg-danger/80" : "bg-accent text-bg-root hover:bg-accent-dim"
            }`}
          >
            允许执行
          </button>
        </div>
      </div>
    </div>
  );
}

/** 从 shell 命令推导规则前缀：首条管道段的前两个 token（如 "git push origin master" → "git push"） */
function deriveRule(args: unknown): string | null {
  if (!args || typeof args !== "object" || !("command" in args)) return null;
  const cmd = String((args as { command: unknown }).command);
  const first = (cmd.split(/[|;&\n]/)[0] ?? "").trim().replace(/\s+/g, " ");
  if (!first) return null;
  const tokens = first.split(" ");
  return tokens.length >= 2 ? tokens.slice(0, 2).join(" ") : tokens[0]!;
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
