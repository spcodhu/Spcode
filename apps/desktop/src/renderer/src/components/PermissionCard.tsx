import { deriveProjectPermissionRule } from "@spcode/shared";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import { DiffReplace } from "./DiffBlock";

/**
 * 权限批准卡：拒绝 / 允许 / 总允许（Finch 式规则沉淀）。
 *
 * - 「总允许」由主进程按当前项目沉淀：普通命令记前缀，危险/复合命令只记完整命令。
 * - bypass 沙盒外执行不生成免审批规则，仍然逐次确认。
 * - 仅 bash/powershell 支持「总允许」；edit/write/network 只支持单次批准。
 */
export function PermissionInline({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("chat");
  const pending = useStore((s) => s.pendingPermissions);
  const queue = pending.filter((p) => p.sessionId === sessionId);
  const reply = useStore((s) => s.replyPermission);
  const request = queue[0];
  if (!request) return null;

  const danger = request.risk === "danger";
  const outward = request.risk === "outward";
  const bypass = request.bypass === true;
  const rule = deriveProjectPermissionRule(request);

  const title = t("permission.shortTitle");
  const severe = danger || outward || bypass;

  const allowAlways = () => reply(request.requestId, true, true);

  return (
    <div className="shrink-0 px-6 pb-2" data-testid="permission-inline" data-session-id={sessionId}>
      <div className="mx-auto max-w-3xl">
        <section
          aria-label={title}
          className="overflow-hidden rounded-2xl border border-warning/35 bg-bg-elevated shadow-lg"
        >
          <div className="flex flex-wrap items-center gap-2 px-4 pt-3.5">
            <div className="text-sm font-semibold text-text-primary">{title}</div>
            {danger && (
              <span className="rounded bg-danger/15 px-1.5 py-0.5 text-[11px] text-danger">
                {t("permission.dangerBadge")}
              </span>
            )}
            {outward && !danger && (
              <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning">
                {t("permission.outwardBadge")}
              </span>
            )}
            {request.sandboxed ? (
              <span
                data-testid="permission-sandboxed-badge"
                className="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] text-accent"
              >
                {t("permission.sandboxed")}
              </span>
            ) : null}
            {bypass ? (
              <span
                data-testid="permission-bypass-badge"
                className="rounded bg-danger/15 px-1.5 py-0.5 text-[11px] text-danger"
              >
                {t("permission.outside")}
              </span>
            ) : null}
            {queue.length > 1 ? (
              <span className="text-[11px] text-text-tertiary">
                {t("permission.pending", { count: queue.length - 1 })}
              </span>
            ) : null}
          </div>
          {/* 评审 R3-F1：edit/write 审批展示 diff/文件预览（批准前看得见改了什么），其余展示参数 */}
          <ArgsPreview toolName={request.toolName} args={request.args} />
          <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3">
            <button
              type="button"
              data-testid="permission-deny"
              onClick={() => reply(request.requestId, false)}
              className="rounded-md border border-border px-4 py-1.5 text-xs text-text-secondary hover:bg-bg-hover"
            >
              {t("permission.deny")}
            </button>
            {rule && (
              <button
                type="button"
                data-testid="permission-allow-always"
                onClick={allowAlways}
                title={t(rule.match === "exact" ? "permission.alwaysExactHint" : "permission.alwaysHint", {
                  rule: rule.command,
                })}
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
                severe ? "bg-danger text-on-danger hover:bg-danger/80" : "bg-accent text-on-accent hover:bg-accent-dim"
              }`}
            >
              {t("permission.allow")}
            </button>
          </div>
        </section>
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

/** 审批卡参数预览（评审 R3-F1）：edit 渲染 oldText→newText 替换 diff，write 渲染目标路径+内容预览，其余 JSON */
function ArgsPreview({ toolName, args }: { toolName: string; args: unknown }) {
  const { t } = useTranslation("chat");
  const a = (args ?? {}) as { path?: unknown; edits?: unknown; content?: unknown; command?: unknown };
  const name = toolName.toLowerCase();
  if ((name === "bash" || name === "powershell") && typeof a.command === "string") {
    return (
      <pre
        data-testid="permission-command"
        className="mono max-h-[40vh] min-w-0 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words px-4 py-3 text-[12px] leading-5 text-text-secondary [overflow-wrap:anywhere]"
      >
        {a.command}
      </pre>
    );
  }
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
