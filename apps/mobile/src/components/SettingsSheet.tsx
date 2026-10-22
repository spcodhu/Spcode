/**
 * 设置弹层：通知开关（Web Push，环境不支持时隐藏）+ 配对信息。
 * 通知默认关，需用户主动开启；开启失败（授权被拒/浏览器不支持订阅）展示原因并维持关闭。
 */

import { getLocale } from "@spcode/shared/i18n";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorText } from "../lib/i18n";
import { isPushEnabledLocally, isPushSupported } from "../lib/push";
import { disablePushNotifications, enablePushNotifications } from "../state/controller";
import { useAppStore } from "../state/store";

export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("mobile");
  const pairing = useAppStore((s) => s.pairing);
  const vapidKey = useAppStore((s) => s.vapidKey);
  const [enabled, setEnabled] = useState(isPushEnabledLocally);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const pushSupported = isPushSupported();

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (enabled) {
        await disablePushNotifications();
        setEnabled(false);
      } else {
        await enablePushNotifications();
        setEnabled(true);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: 遮罩点击关闭（移动端底部弹层惯例手势）
    <div className="absolute inset-0 z-30 flex flex-col justify-end bg-black/60" onClick={onClose}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: 纯事件隔离容器，阻止冒泡到遮罩关闭，本身不是控件 */}
      <div
        className="rounded-t-2xl border-t border-slate-700 bg-[#11161d] p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold text-slate-100">{t("common.settings")}</div>

        {pushSupported && (
          <div className="mt-4 flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-slate-100">{t("settings.push")}</div>
              <div className="mt-0.5 text-[11px] leading-4 text-slate-500">
                {t("settings.pushHelp")}
                {!vapidKey && enabled === false && (
                  <span className="block text-amber-400/80">{t("settings.waitPushKey")}</span>
                )}
              </div>
            </div>
            <button
              type="button"
              disabled={busy || (!enabled && !vapidKey)}
              onClick={() => void toggle()}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                enabled ? "bg-emerald-600" : "bg-slate-700"
              } disabled:opacity-40`}
              aria-label={enabled ? t("settings.disablePush") : t("settings.enablePush")}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${enabled ? "left-[22px]" : "left-0.5"}`}
              />
            </button>
          </div>
        )}
        {error != null && <div className="mt-2 text-xs text-red-400">{errorText(error)}</div>}

        {pairing && (
          <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-[11px] leading-5 text-slate-500">
            <div>
              {t("settings.device")}
              <span className="text-slate-300">{pairing.deviceName}</span>
              {t("settings.deviceId", { id: pairing.deviceId.slice(0, 8) })}
            </div>
            <div>
              {t("settings.desktopKey")}
              <span className="font-mono">{pairing.desktopPk.slice(0, 12)}…</span>
            </div>
            <div>
              {t("settings.channels", {
                channels: new Intl.ListFormat(getLocale()).format(
                  pairing.hosts.map((h) => (h.startsWith("relay+") ? t("settings.relay") : h)),
                ),
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
