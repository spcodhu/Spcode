/**
 * 首屏加载动画：冷启动/新配对后、内容一次性放行前展示。
 * 与 index.html 的内联 splash 同款（品牌字标 + 环形 spinner），保证 JS 加载前后无缝衔接。
 * 兜底：长时间未放行（如桌面离线）时主动露出真实连接状态，避免无限转圈。
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { revealBootStatus } from "../state/controller";

/** 超过该时长仍未放行则露出真实连接状态（横幅/重试入口），而非无限加载动画。 */
const BOOT_REVEAL_MS = 15_000;

export function BootLoader() {
  const { t } = useTranslation("mobile");

  useEffect(() => {
    const timer = setTimeout(() => revealBootStatus(), BOOT_REVEAL_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      role="status"
      data-testid="boot-loader"
      className="flex h-full flex-col items-center justify-center gap-4 px-6"
    >
      <div className="text-lg font-semibold tracking-tight text-text-primary">Spcode</div>
      <div className="boot-spinner" aria-hidden="true" />
      <div className="text-xs text-text-tertiary">{t("boot.loading")}</div>
    </div>
  );
}
