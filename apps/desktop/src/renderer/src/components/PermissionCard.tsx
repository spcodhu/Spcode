import { Trans, useTranslation } from "react-i18next";
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
  const { t } = useTranslation("chat");
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

  const title = t(
    bypass
      ? "permission.bypassTitle"
      : danger
        ? "permission.dangerTitle"
        : outward
          ? "permission.outwardTitle"
          : "permission.title",
  );
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
            <Trans
              t={t}
              i18nKey="permission.tool"
              values={{ name: request.toolName }}
              components={{ code: <code className="mono text-text-secondary" /> }}
            />
            {request.sandboxed ? (
              <span
                data-testid="permission-sandboxed-badge"
                className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-accent"
              >
                {t("permission.sandboxed")}
              </span>
            ) : null}
            {bypass ? (
              <span
                data-testid="permission-bypass-badge"
                className="ml-2 rounded bg-danger/15 px-1.5 py-0.5 text-danger"
              >
                {t("permission.outside")}
              </span>
            ) : null}
            {pending.length > 1 ? t("permission.pending", { count: pending.length - 1 }) : ""}
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
            {t("permission.deny")}
          </button>
          {!danger && rule && (
            <button
              type="button"
              data-testid="permission-allow-always"
              onClick={allowAlways}
              title={t(bypass ? "permission.alwaysBypassHint" : "permission.alwaysHint", { rule })}
              className="rounded-md border border-border px-4 py-1.5 text-xs text-text-secondary hover:bg-bg-hover"
            >
              {t("permission.always")}
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
            {t("permission.allow")}
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
  const { t } = useTranslation("chat");
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
        {edits.length > 3 && (
          <div className="mt-1 text-xs text-text-tertiary">
            {t("permission.moreEdits", { count: edits.length - 3 })}
          </div>
        )}
      </div>
    );
  }
  if (name === "write" && typeof a.path === "string") {
    const content = typeof a.content === "string" ? a.content : "";
    return (
      <div className="max-h-72 overflow-auto px-4 py-3">
        <div className="mono mb-2 truncate text-xs text-text-tertiary" title={a.path}>
          {t("permission.overwrite", { path: a.path, count: content.length })}
        </div>
        {content && (
          <pre className="mono max-h-52 overflow-auto rounded-lg border border-border bg-bg-root/60 px-3 py-2 text-[12px] leading-5 text-text-secondary">
            {content.slice(0, 1200)}
            {content.length > 1200 ? t("permission.previewTruncated") : ""}
          </pre>
        )}
      </div>
    );
  }
  return (
    <pre className="max-h-56 overflow-auto px-4 py-3 text-xs leading-5 text-text-secondary">{formatArgs(args)}</pre>
  );
}
