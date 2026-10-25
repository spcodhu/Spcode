import { renderMessage } from "@spcode/shared/i18n";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import { Icon } from "./Icon";

/** 单一 Toast Region：通知与错误垂直堆叠，悬浮/聚焦时暂停自动消失。 */
export function ToastRegion() {
  const { t } = useTranslation("chat");
  const notice = useStore((s) => s.notice);
  const lastError = useStore((s) => s.lastError);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!notice || paused) return;
    const timer = setTimeout(() => useStore.setState({ notice: null }), 8000);
    return () => clearTimeout(timer);
  }, [notice, paused]);
  useEffect(() => {
    if (!lastError || paused) return;
    const timer = setTimeout(() => useStore.setState({ lastError: null }), 6000);
    return () => clearTimeout(timer);
  }, [lastError, paused]);

  if (!notice && !lastError) return null;
  return (
    <section
      aria-label={t("common.notifications")}
      className="fixed bottom-4 right-4 z-50 flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-2"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
      }}
      data-testid="toast-region"
    >
      {notice && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-xl border border-accent/40 bg-bg-elevated px-4 py-3 text-sm text-text-primary shadow-xl"
        >
          <Icon
            name={notice.tone === "success" ? "check" : "clock"}
            size={15}
            className="mt-0.5 shrink-0 text-accent"
          />
          <button
            type="button"
            onClick={() => {
              if (notice.sessionId) void useStore.getState().openSessionById(notice.sessionId);
              useStore.setState({ notice: null });
            }}
            className="min-w-0 flex-1 text-left"
          >
            <span className="block whitespace-pre-wrap break-words">
              {notice.presentation ? renderMessage(notice.presentation) : notice.text}
            </span>
          </button>
          <button
            type="button"
            onClick={() => useStore.setState({ notice: null })}
            title={t("common.close")}
            aria-label={t("common.close")}
            className="shrink-0 rounded p-0.5 text-text-tertiary hover:text-text-primary"
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
      {lastError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-danger/40 bg-bg-elevated px-4 py-3 text-sm text-danger shadow-xl"
        >
          <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{lastError}</span>
          <button
            type="button"
            onClick={() => useStore.setState({ lastError: null })}
            className="shrink-0 rounded p-0.5 text-text-tertiary hover:text-text-primary"
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
    </section>
  );
}
