import type { ScheduleTask } from "@spcode/shared";
import { getLocale, i18n, localeProfile, renderMessage, resolveLocale, setLocale } from "@spcode/shared/i18n";

export const LOCALE_CACHE_KEY = "spcode.mobile.locale";
export type MobileKey = keyof typeof import("../../../../packages/shared/src/i18n/mobile").zhCN;

export function mobileText(key: MobileKey, params?: Record<string, string | number>): string {
  return renderMessage({ key: `mobile:${key}`, params });
}

/** Keep owned errors as keys until render; errors from the desktop/browser remain verbatim. */
export class MobileError extends Error {
  constructor(
    readonly key: MobileKey,
    readonly params?: Record<string, string | number>,
  ) {
    super();
    this.name = "MobileError";
    Object.defineProperty(this, "message", { configurable: true, get: () => mobileText(key, params) });
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The installed worker receives only locale metadata and a generic title, never session data. */
export function syncWorkerLocale(worker: ServiceWorker | null | undefined): void {
  worker?.postMessage({ type: "locale.changed", locale: getLocale(), title: mobileText("app.title") });
}

function syncBrowserLocale(): void {
  const locale = getLocale();
  try {
    localStorage.setItem(LOCALE_CACHE_KEY, locale);
  } catch {
    // Private browsing / disabled storage must not prevent pairing or connecting.
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
    document.documentElement.dir = i18n.dir(locale);
    document.title = mobileText("app.title");
  }
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    void navigator.serviceWorker
      .getRegistration()
      .then((reg) => syncWorkerLocale(reg?.active))
      .catch(() => {});
  }
}

let listening = false;
/** Synchronous before React renders; ignore browser language in favor of the shared build profile. */
export function initializeMobileLocale(): void {
  let cached: unknown;
  try {
    cached = localStorage.getItem(LOCALE_CACHE_KEY);
  } catch {
    // Use the profile default when storage is unavailable.
  }
  if (!listening) {
    i18n.on("languageChanged", syncBrowserLocale);
    listening = true;
  }
  setLocale(resolveLocale(cached));
  syncBrowserLocale();
}

export function applyDesktopLocale(locale: unknown): void {
  setLocale(resolveLocale(locale));
  syncBrowserLocale();
}

export function workerScriptUrl(): string {
  const params = new URLSearchParams({
    defaultLocale: resolveLocale(localeProfile.defaultLocale),
    locale: getLocale(),
    supportedLocales: localeProfile.supportedLocales.join(","),
  });
  return `sw.js?${params}`;
}

export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(getLocale(), {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(getLocale()).format(value);
}

export function formatWeekday(day: number): string {
  return new Intl.DateTimeFormat(getLocale(), { weekday: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(2024, 0, 7 + day)),
  );
}

/** UI description only; schedule names, prompts, paths and persisted values are untouched. */
export function describeMobileSchedule(task: ScheduleTask): string {
  const time = new Intl.DateTimeFormat(getLocale(), { hour: "2-digit", minute: "2-digit" }).format(
    new Date(2024, 0, 7, task.hour, task.minute),
  );
  switch (task.frequency) {
    case "once":
      return task.runAt
        ? mobileText("schedule.describeOnce", { time: formatDate(task.runAt) })
        : mobileText("schedule.once");
    case "hourly":
      return mobileText("schedule.describeHourly", { minute: formatNumber(task.minute) });
    case "daily":
      return mobileText("schedule.describeDaily", { time });
    case "weekday":
      return mobileText("schedule.describeWeekday", { time });
    case "weekly":
      return mobileText("schedule.describeWeekly", { weekday: formatWeekday(task.weekday ?? 1), time });
  }
}
