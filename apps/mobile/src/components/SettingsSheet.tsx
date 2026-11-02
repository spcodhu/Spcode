/**
 * 设置弹层：通知开关（Web Push）+ 配对信息。
 * 通知默认关，需用户主动开启；不支持的环境展示原因，开启失败展示错误并维持关闭。
 */

import { getLocale } from "@spcode/shared/i18n";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorText } from "../lib/i18n";
import { isPushEnabledLocally, isPushSupported } from "../lib/push";
import { isRelayHost, OFFICIAL_RELAY_URL, RELAY_HOST_PREFIX } from "../lib/relay";
import {
  disablePushNotifications,
  enablePushNotifications,
  probeRelayConfiguration,
  updateRelayConfiguration,
} from "../state/controller";
import { useAppStore } from "../state/store";
import { Sheet } from "./Sheet";

export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("mobile");
  const pairing = useAppStore((s) => s.pairing);
  const themeBase = useAppStore((s) => s.themeBase);
  const setThemeBase = useAppStore((s) => s.setThemeBase);
  const vapidKey = useAppStore((s) => s.vapidKey);
  const [enabled, setEnabled] = useState(isPushEnabledLocally);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const relayHost = pairing?.hosts.find(isRelayHost) ?? null;
  const currentRelayMode = relayHost
    ? relayHost === `${RELAY_HOST_PREFIX}${OFFICIAL_RELAY_URL}`
      ? "official"
      : "custom"
    : "disabled";
  const [relayMode, setRelayMode] = useState<"official" | "custom" | "disabled">(currentRelayMode);
  const [relayUrl, setRelayUrl] = useState(relayHost?.slice(RELAY_HOST_PREFIX.length) ?? "");
  const [relayKey, setRelayKey] = useState(pairing?.relayAccessKey ?? "");
  const [relayBusy, setRelayBusy] = useState(false);
  const [relayTestText, setRelayTestText] = useState<string | null>(null);

  const pushSupported = isPushSupported();
  const pushActive = enabled && pushSupported;

  const testRelay = async () => {
    setRelayBusy(true);
    setRelayTestText(null);
    setError(null);
    try {
      await probeRelayConfiguration({
        url: relayMode === "official" ? OFFICIAL_RELAY_URL : relayUrl.trim(),
        accessKey: relayMode === "custom" ? relayKey.trim() || null : null,
      });
      setRelayTestText(t("settings.relayTestSuccess"));
    } catch (err) {
      setError(err);
    } finally {
      setRelayBusy(false);
    }
  };

  const saveRelay = async () => {
    setRelayBusy(true);
    setError(null);
    try {
      await updateRelayConfiguration(relayMode, relayUrl, relayKey);
    } catch (err) {
      setError(err);
    } finally {
      setRelayBusy(false);
    }
  };

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
    <Sheet title={t("common.settings")} onClose={onClose} busy={busy || relayBusy}>
      <div className="space-y-4">
        <div className="rounded-2xl border border-border bg-bg-elevated px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-text-primary">{t("settings.appearance")}</div>
              <div className="safe-break mt-1 text-xs leading-5 text-text-tertiary">{t("settings.darkModeHelp")}</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={themeBase === "dark"}
              onClick={() => setThemeBase(themeBase === "dark" ? "light" : "dark")}
              className="relative h-11 w-12 shrink-0 rounded-full"
              aria-label={t("settings.darkMode")}
              data-testid="theme-toggle"
            >
              <span
                aria-hidden="true"
                className={`absolute left-0.5 top-2.5 h-6 w-11 rounded-full transition-colors ${
                  themeBase === "dark" ? "bg-accent" : "bg-bg-active"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all ${
                    themeBase === "dark" ? "left-[22px]" : "left-0.5"
                  }`}
                />
              </span>
            </button>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-bg-elevated px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-text-primary">{t("settings.push")}</div>
              <div className="safe-break mt-1 text-xs leading-5 text-text-tertiary">{t("settings.pushHelp")}</div>
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
                  pushActive ? "bg-accent" : "bg-bg-active"
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
          <div className="rounded-2xl border border-border bg-bg-elevated px-4 py-3">
            <div className="text-sm font-medium text-text-primary">{t("settings.relayServer")}</div>
            <div className="safe-break mt-1 text-xs leading-5 text-text-tertiary">{t("settings.relayServerHelp")}</div>
            <div className="mt-3 grid grid-cols-3 gap-2" data-testid="mobile-relay-modes">
              {(["official", "custom", "disabled"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={relayMode === mode}
                  onClick={() => setRelayMode(mode)}
                  className={`min-h-11 rounded-lg border px-2 py-2 text-xs ${
                    relayMode === mode
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-border text-text-secondary"
                  }`}
                >
                  {t(`settings.relayMode.${mode}`)}
                </button>
              ))}
            </div>
            {relayMode === "official" && (
              <div className="safe-break mt-3 rounded-lg bg-bg-main px-3 py-2 font-mono text-[11px] leading-5 text-text-secondary">
                {OFFICIAL_RELAY_URL}
              </div>
            )}
            {relayMode === "custom" && (
              <div className="mt-3 space-y-2">
                <input
                  value={relayUrl}
                  onChange={(event) => setRelayUrl(event.target.value)}
                  placeholder="wss://relay.example.com"
                  aria-label={t("settings.relayUrl")}
                  data-testid="mobile-relay-url"
                  className="min-h-11 w-full rounded-xl border border-border-strong bg-bg-main/70 px-3 py-2.5 font-mono text-base text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent"
                />
                <input
                  type="password"
                  value={relayKey}
                  onChange={(event) => setRelayKey(event.target.value)}
                  placeholder={t("settings.relayKeyPlaceholder")}
                  aria-label={t("settings.relayKey")}
                  data-testid="mobile-relay-key"
                  className="min-h-11 w-full rounded-xl border border-border-strong bg-bg-main/70 px-3 py-2.5 font-mono text-base text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent"
                />
              </div>
            )}
            {relayMode !== "disabled" && (
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  data-testid="mobile-relay-test"
                  disabled={relayBusy}
                  onClick={() => void testRelay()}
                  className="min-h-11 flex-1 rounded-xl border border-border px-3 text-xs text-text-secondary disabled:opacity-40"
                >
                  {t("settings.relayTest")}
                </button>
                <button
                  type="button"
                  data-testid="mobile-relay-save"
                  disabled={relayBusy}
                  onClick={() => void saveRelay()}
                  className="min-h-11 flex-1 rounded-xl bg-accent px-3 text-xs font-medium text-on-accent disabled:opacity-40"
                >
                  {t("common.save")}
                </button>
              </div>
            )}
            {relayMode === "disabled" && (
              <button
                type="button"
                data-testid="mobile-relay-save"
                disabled={relayBusy}
                onClick={() => void saveRelay()}
                className="mt-3 min-h-11 w-full rounded-xl bg-accent px-3 text-xs font-medium text-on-accent disabled:opacity-40"
              >
                {t("common.save")}
              </button>
            )}
            {relayTestText && (
              <div role="status" className="mt-2 text-xs text-success">
                {relayTestText}
              </div>
            )}
          </div>
        )}

        {pairing && (
          <div className="safe-break rounded-2xl border border-border bg-bg-elevated px-4 py-3 text-xs leading-6 text-text-tertiary">
            <div>
              {t("settings.device")}
              <span className="text-text-primary">{pairing.deviceName}</span>
              {t("settings.deviceId", { id: pairing.deviceId.slice(0, 8) })}
            </div>
            <div>
              {t("settings.desktopKey")}
              <span className="font-mono text-text-secondary">{pairing.desktopPk.slice(0, 12)}…</span>
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
