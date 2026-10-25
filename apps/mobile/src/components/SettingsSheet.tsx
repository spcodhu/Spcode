/**
 * 设置弹层：通知开关（Web Push）+ 配对信息。
 * 通知默认关，需用户主动开启；不支持的环境展示原因，开启失败展示错误并维持关闭。
 */

import { getLocale } from "@spcode/shared/i18n";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorText } from "../lib/i18n";
import { isPushEnabledLocally, isPushSupported } from "../lib/push";
import { disablePushNotifications, enablePushNotifications } from "../state/controller";
import { useAppStore } from "../state/store";
import { Sheet } from "./Sheet";

export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("mobile");
  const pairing = useAppStore((s) => s.pairing);
  const vapidKey = useAppStore((s) => s.vapidKey);
  const [enabled, setEnabled] = useState(isPushEnabledLocally);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const pushSupported = isPushSupported();
  const pushActive = enabled && pushSupported;

  const toggle = async () => {
    if (busy || !pushSupported) return;
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
    <Sheet title={t("common.settings")} onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/55 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-slate-100">{t("settings.push")}</div>
              <div className="safe-break mt-1 text-xs leading-5 text-slate-400">{t("settings.pushHelp")}</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={pushActive}
              disabled={busy || !pushSupported || (!enabled && !vapidKey)}
              onClick={() => void toggle()}
              className="relative h-11 w-12 shrink-0 rounded-full disabled:opacity-40"
              aria-label={pushActive ? t("settings.disablePush") : t("settings.enablePush")}
            >
              <span
                aria-hidden="true"
                className={`absolute left-0.5 top-2.5 h-6 w-11 rounded-full transition-colors ${
                  pushActive ? "bg-teal-600" : "bg-slate-700"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all ${
                    pushActive ? "left-[22px]" : "left-0.5"
                  }`}
                />
              </span>
            </button>
          </div>
          {!pushSupported && (
            <div data-testid="push-unsupported" className="safe-break mt-2 text-xs leading-5 text-amber-200/90">
              {t("settings.pushUnsupported")}
            </div>
          )}
          {pushSupported && !vapidKey && !enabled && (
            <div className="safe-break mt-2 text-xs leading-5 text-amber-200/90">{t("settings.waitPushKey")}</div>
          )}
        </div>

        {error != null && (
          <div role="alert" className="safe-break text-xs leading-5 text-red-300">
            {errorText(error)}
          </div>
        )}

        {pairing && (
          <div className="safe-break rounded-2xl border border-slate-800 bg-slate-900/55 px-4 py-3 text-xs leading-6 text-slate-400">
            <div>
              {t("settings.device")}
              <span className="text-slate-200">{pairing.deviceName}</span>
              {t("settings.deviceId", { id: pairing.deviceId.slice(0, 8) })}
            </div>
            <div>
              {t("settings.desktopKey")}
              <span className="font-mono text-slate-300">{pairing.desktopPk.slice(0, 12)}…</span>
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
    </Sheet>
  );
}
