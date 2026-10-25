/**
 * 权限批准卡：permission.request 到达时全屏置顶。
 * - 完整参数可滚动核对；danger 支持单指长按与可访问的两步确认；
 * - 回复等待桌面确认，失败保留卡片并允许用户手动重试。
 */

import type { PermissionRequest, ToolRisk } from "@spcode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorText } from "../lib/i18n";
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

/** danger 长按确认：只认启动时的 pointerId，取消/丢失捕获/其他手指都不会误触批准。 */
function HoldToApproveButton({ onConfirm, disabled }: { onConfirm: () => void; disabled: boolean }) {
  const { t } = useTranslation("mobile");
  const [progress, setProgress] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef(0);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const activePointerRef = useRef<number | null>(null);
  const keyboardActiveRef = useRef(false);

  const clear = useCallback((pointerId?: number) => {
    if (pointerId !== undefined && activePointerRef.current !== pointerId) return;
    const activePointer = activePointerRef.current;
    activePointerRef.current = null;
    keyboardActiveRef.current = false;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setProgress(0);
    const button = buttonRef.current;
    if (activePointer !== null && button?.hasPointerCapture?.(activePointer)) {
      try {
        button.releasePointerCapture(activePointer);
      } catch {
        // 捕获可能已由浏览器在 pointerup/cancel 时释放。
      }
    }
  }, []);

  const start = (pointerId: number | null) => {
    if (disabled || timerRef.current) return;
    if (pointerId !== null) {
      // 已有一根手指/指针按住时，后续多指完全忽略。
      if (activePointerRef.current !== null) return;
      activePointerRef.current = pointerId;
    } else {
      if (activePointerRef.current !== null) return;
      keyboardActiveRef.current = true;
    }
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

  useEffect(() => {
    if (disabled) clear();
  }, [clear, disabled]);

  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      activePointerRef.current = null;
      keyboardActiveRef.current = false;
    },
    [],
  );

  return (
    <button
      ref={buttonRef}
      type="button"
      data-testid="danger-hold"
      disabled={disabled}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        start(event.pointerId);
        if (activePointerRef.current === event.pointerId) {
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // 不支持 pointer capture 的环境仍由 up/cancel/leave/blur 兜底。
          }
        }
      }}
      onPointerUp={(event) => clear(event.pointerId)}
      onPointerCancel={(event) => clear(event.pointerId)}
      onLostPointerCapture={(event) => clear(event.pointerId)}
      onPointerLeave={(event) => clear(event.pointerId)}
      onKeyDown={(event) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) {
          event.preventDefault();
          start(null);
        }
      }}
      onKeyUp={(event) => {
        if ((event.key === " " || event.key === "Enter") && keyboardActiveRef.current) clear();
      }}
      onBlur={() => clear()}
      onContextMenu={(event) => event.preventDefault()}
      className="relative min-h-12 flex-1 select-none overflow-hidden rounded-xl border border-red-700 px-3 py-3 text-sm font-medium text-red-100 transition-colors disabled:opacity-40"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 bg-red-700/60"
        style={{ width: `${progress * 100}%` }}
      />
      <span className="relative">
        {disabled ? t("request.submitting") : progress > 0 ? t("permission.keepHolding") : t("permission.holdApprove")}
      </span>
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
  const [error, setError] = useState<unknown>(null);
  const [reviewed, setReviewed] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const reply = async (approved: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await replyPermission(request.requestId, approved);
    } catch (err) {
      if (mountedRef.current) setError(err);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  return (
    <FullScreenDialog
      role="alertdialog"
      busy={busy}
      title={danger ? t("permission.dangerTitle") : bypass ? t("permission.bypassTitle") : t("permission.title")}
      description={t("permission.session", { title: session?.title ?? request.sessionId })}
      titleClassName={severe ? "text-red-300" : "text-amber-200"}
      panelClassName={severe ? "permission-severe" : ""}
      footer={
        <div className="flex gap-3">
          {danger ? (
            <HoldToApproveButton disabled={busy} onConfirm={() => void reply(true)} />
          ) : (
            <button
              type="button"
              data-testid="permission-allow"
              disabled={busy}
              onClick={() => void reply(true)}
              className="min-h-12 flex-1 rounded-xl bg-teal-700 px-3 py-3 text-sm font-medium text-white transition-colors active:bg-teal-600 disabled:opacity-40"
            >
              {busy ? t("request.submitting") : t("permission.allow")}
            </button>
          )}
          <button
            type="button"
            data-testid="permission-deny"
            disabled={busy}
            onClick={() => void reply(false)}
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
        <section
          aria-label={t("permission.arguments")}
          className="thin-scroll mt-3 max-h-80 overflow-auto rounded-xl bg-black/35"
        >
          <pre className="safe-break whitespace-pre-wrap p-3 font-mono text-xs leading-6 text-slate-300">
            {formatArgs(request.args)}
          </pre>
        </section>
        {danger && (
          <div className="safe-break mt-3 rounded-xl border border-red-900 bg-red-950/60 px-3 py-2.5 text-xs leading-5 text-red-200">
            {t("permission.dangerWarning")}
          </div>
        )}
        {danger && (
          <div className="mt-3 rounded-xl border border-slate-700 px-3 py-2.5">
            <p className="text-xs leading-5 text-slate-400">{t("permission.alternativeHelp")}</p>
            <button
              type="button"
              data-testid={reviewed ? "danger-confirm" : "danger-reviewed"}
              disabled={busy}
              onClick={() => (reviewed ? void reply(true) : setReviewed(true))}
              className="mt-2 min-h-11 w-full rounded-xl border border-red-700 px-3 py-2 text-xs font-medium text-red-100 disabled:opacity-40"
            >
              {busy ? t("request.submitting") : reviewed ? t("permission.confirmDanger") : t("permission.reviewedArgs")}
            </button>
          </div>
        )}
        {bypass && !danger && (
          <div className="safe-break mt-3 rounded-xl border border-red-900 bg-red-950/60 px-3 py-2.5 text-xs leading-5 text-red-200">
            {t("permission.bypassWarning")}
          </div>
        )}
        {error != null && (
          <div
            role="alert"
            className="safe-break mt-3 rounded-xl border border-red-900/60 bg-red-950/40 px-3 py-2.5 text-xs leading-5 text-red-300"
          >
            {errorText(error)}
          </div>
        )}
      </section>
    </FullScreenDialog>
  );
}
