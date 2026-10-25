/**
 * 权限批准卡：permission.request 到达时全屏置顶。
 * - 完整显示工具参数，正文滚动，风险操作仍需长按二次确认；
 * - 桌面与手机可能同时收到：回复后本地卡片消失即可（先到先得，对端忽略重复）。
 */

import type { PermissionRequest, ToolRisk } from "@spcode/shared";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { replyPermission } from "../state/controller";
import { useAppStore } from "../state/store";
import { FullScreenDialog } from "./Sheet";

const RISK_CLASS: Record<ToolRisk, string> = {
  readonly: "bg-slate-800 text-slate-300",
  write: "bg-amber-950 text-amber-300",
  outward: "bg-orange-950 text-orange-300",
  danger: "bg-red-950 text-red-200",
};

function formatArgs(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2) ?? String(args);
  } catch {
    return String(args);
  }
}

/** danger 级二次确认：指针或键盘持续按住 1.5s（带进度）才触发批准 */
function HoldToApproveButton({ onConfirm, disabled }: { onConfirm: () => void; disabled: boolean }) {
  const { t } = useTranslation("mobile");
  const [progress, setProgress] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef(0);

  const clear = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setProgress(0);
  };

  const start = () => {
    if (disabled || timerRef.current) return;
    startRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const p = (Date.now() - startRef.current) / 1500;
      if (p >= 1) {
        clear();
        onConfirm();
      } else {
        setProgress(p);
      }
    }, 30);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在组件卸载时清理定时器
  useEffect(() => clear, []);

  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={clear}
      onPointerCancel={clear}
      onPointerLeave={clear}
      onKeyDown={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          start();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") clear();
      }}
      onBlur={clear}
      onContextMenu={(event) => event.preventDefault()}
      className="relative min-h-12 flex-1 select-none overflow-hidden rounded-xl border border-red-700 px-3 py-3 text-sm font-medium text-red-100 transition-colors disabled:opacity-40"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 bg-red-700/60"
        style={{ width: `${progress * 100}%` }}
      />
      <span className="relative">{progress > 0 ? t("permission.keepHolding") : t("permission.holdApprove")}</span>
    </button>
  );
}

export function PermissionCard({ request }: { request: PermissionRequest }) {
  const { t } = useTranslation("mobile");
  const session = useAppStore((s) => s.sessions[request.sessionId]);
  const danger = request.risk === "danger";
  const bypass = request.bypass === true;
  const severe = danger || bypass;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const reply = (approved: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void replyPermission(request.requestId, approved);
  };

  return (
    <FullScreenDialog
      role="alertdialog"
      title={danger ? t("permission.dangerTitle") : bypass ? t("permission.bypassTitle") : t("permission.title")}
      description={t("permission.session", { title: session?.title ?? request.sessionId })}
      titleClassName={severe ? "text-red-300" : "text-amber-200"}
      panelClassName={severe ? "permission-severe" : ""}
      footer={
        <div className="flex gap-3">
          {danger ? (
            <HoldToApproveButton disabled={busy} onConfirm={() => reply(true)} />
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => reply(true)}
              className="min-h-12 flex-1 rounded-xl bg-teal-700 px-3 py-3 text-sm font-medium text-white transition-colors active:bg-teal-600 disabled:opacity-40"
            >
              {t("permission.allow")}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => reply(false)}
            className="min-h-12 flex-1 rounded-xl bg-slate-800 px-3 py-3 text-sm font-medium text-slate-100 transition-colors active:bg-slate-700 disabled:opacity-40"
          >
            {t("permission.deny")}
          </button>
        </div>
      }
    >
      <section className="rounded-2xl border border-slate-700/80 bg-slate-900/60 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="safe-break min-w-0 font-mono text-sm font-semibold text-slate-100">{request.toolName}</span>
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] ${RISK_CLASS[request.risk]}`}>
            {t(`permission.${request.risk}`)}
          </span>
        </div>
        <pre className="safe-break mt-3 whitespace-pre-wrap rounded-xl bg-black/35 p-3 font-mono text-xs leading-6 text-slate-300">
          {formatArgs(request.args)}
        </pre>
        {danger && (
          <div className="safe-break mt-3 rounded-xl border border-red-900 bg-red-950/60 px-3 py-2.5 text-xs leading-5 text-red-200">
            {t("permission.dangerWarning")}
          </div>
        )}
        {bypass && !danger && (
          <div className="safe-break mt-3 rounded-xl border border-red-900 bg-red-950/60 px-3 py-2.5 text-xs leading-5 text-red-200">
            {t("permission.bypassWarning")}
          </div>
        )}
      </section>
    </FullScreenDialog>
  );
}
