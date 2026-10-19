import { useStore } from "../store";
import { DiffReplace } from "./DiffBlock";

/**
 * 权限批准卡：拒绝 / 允许 / 总允许（Finch 式规则沉淀）。
 *
 * - 「总允许」：把命令前缀（前两个 token）写入 permissionRules，
 *   以后同类命令免弹窗；复合命令不推导规则（评审 R3-C5）；逃生舱请求（bypass）额外双写 sandbox.excludedCommands——
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
        {/* 评审 R3-F1：edit/write 审批展示 diff/文件预览（批准前看得见改了什么），其余展示参数 */}
        <ArgsPreview toolName={request.toolName} args={request.args} />
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

/** 从 shell 命令推导规则前缀：前两个 token（如 "git push origin master" → "git push"）；
 *  评审 R3-C5：复合命令（含元字符）不可沉淀规则——规则匹配已不支持复合，推导同步拒绝 */
function deriveRule(args: unknown): string | null {
  if (!args || typeof args !== "object" || !("command" in args)) return null;
  const cmd = String((args as { command: unknown }).command);
  if (/[;|&<>\n`$]/.test(cmd)) return null;
  const first = cmd.trim().replace(/\s+/g, " ");
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

/** 审批卡参数预览（评审 R3-F1）：edit 渲染 oldText→newText 替换 diff，write 渲染目标路径+内容预览，其余 JSON */
function ArgsPreview({ toolName, args }: { toolName: string; args: unknown }) {
  const a = (args ?? {}) as { path?: unknown; edits?: unknown; content?: unknown };
  const name = toolName.toLowerCase();
  if (name === "edit" && typeof a.path === "string" && Array.isArray(a.edits)) {
    const edits = a.edits as { oldText?: unknown; newText?: unknown }[];
    return (
      <div className="max-h-72 overflow-auto px-4 py-3">
        <div className="mono mb-2 truncate text-xs text-text-tertiary" title={a.path}>
          {a.path}
        </div>
        {edits.slice(0, 3).map((e, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 审批卡静态列表不重排
          <DiffReplace key={i} oldText={String(e.oldText ?? "")} newText={String(e.newText ?? "")} />
        ))}
        {edits.length > 3 && <div className="mt-1 text-xs text-text-tertiary">…还有 {edits.length - 3} 处修改</div>}
      </div>
    );
  }
  if (name === "write" && typeof a.path === "string") {
    const content = typeof a.content === "string" ? a.content : "";
    return (
      <div className="max-h-72 overflow-auto px-4 py-3">
        <div className="mono mb-2 truncate text-xs text-text-tertiary" title={a.path}>
          {a.path}（{content.length} 字符，整文件覆写）
        </div>
        {content && (
          <pre className="mono max-h-52 overflow-auto rounded-lg border border-border bg-bg-root/60 px-3 py-2 text-[12px] leading-5 text-text-secondary">
            {content.slice(0, 1200)}
            {content.length > 1200 ? "\n…（预览截断）" : ""}
          </pre>
        )}
      </div>
    );
  }
  return (
    <pre className="max-h-56 overflow-auto px-4 py-3 text-xs leading-5 text-text-secondary">{formatArgs(args)}</pre>
  );
}
