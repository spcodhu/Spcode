/**
 * 生图等待态：同步接口没有真实进度回调，因此使用不确定进度条 + 已等待秒数，
 * 不伪造百分比。设置页测试与会话中的每个 GenerateImage 调用共用。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";

export function ImageGenProgress({
  title,
  description,
  testId,
  variant = "inline",
}: {
  title: string;
  description?: string;
  testId: string;
  /** card 对应消息流里的图片占位卡片；inline 对应设置页测试状态 */
  variant?: "card" | "inline";
}) {
  const { t } = useTranslation("chat");
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={title}
      data-testid={testId}
      className={
        variant === "card"
          ? "flex aspect-[16/10] w-80 max-w-full shrink-0 flex-col justify-center overflow-hidden rounded-xl border border-accent/20 bg-bg-elevated px-5 py-4"
          : "mt-3 rounded-xl border border-accent/20 bg-accent-soft/35 px-4 py-3"
      }
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <span className="absolute inset-0 animate-ping rounded-lg bg-accent/10 motion-reduce:animate-none" />
          <Icon name="sparkles" size={17} className="relative animate-pulse" />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className="thinking-shimmer block whitespace-nowrap text-[14px] font-medium"
            data-testid={`${testId}-title`}
          >
            {title}
          </span>
          <span className="mt-1 block tabular-nums text-[11px] text-text-tertiary" data-testid={`${testId}-elapsed`}>
            {t("imageGen.elapsed", { seconds: elapsed })}
          </span>
          {variant === "inline" && description && (
            <span className="mt-1 block text-[11.5px] leading-4 text-text-tertiary">{description}</span>
          )}
        </span>
      </div>
      <div className="image-gen-progress-track mt-4" aria-hidden>
        <span className="image-gen-progress-bar" />
      </div>
    </div>
  );
}
