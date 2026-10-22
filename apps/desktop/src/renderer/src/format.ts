import { getLocale, i18n } from "@spcode/shared/i18n";

/** Locale-aware usage counts. The historical export name is kept for callers. */
export function formatZh(n: number): string {
  const locale = getLocale();
  if (locale === "zh-CN") {
    const digits = n >= 1e8 ? (n / 1e8 >= 10 ? 1 : 2) : n / 1e4 >= 100 ? 0 : 1;
    return new Intl.NumberFormat(locale, {
      notation: n >= 1e4 ? "compact" : "standard",
      maximumFractionDigits: n >= 1e4 ? digits : 3,
    }).format(n);
  }
  return new Intl.NumberFormat(locale, {
    notation: n >= 1e3 ? "compact" : "standard",
    maximumFractionDigits: n >= 1e3 ? 1 : 3,
  }).format(n);
}

/** 相对时间：刚刚 / N分钟前 / N小时前 / N天前 / MM-DD */
export function formatRelative(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return i18n.t("settings:format.justNow");
  const relative = new Intl.RelativeTimeFormat(getLocale(), { numeric: "always" });
  if (diff < 3_600_000) return relative.format(-Math.floor(diff / 60_000), "minute");
  if (diff < 86_400_000) return relative.format(-Math.floor(diff / 3_600_000), "hour");
  if (diff < 7 * 86_400_000) return relative.format(-Math.floor(diff / 86_400_000), "day");
  return new Intl.DateTimeFormat(getLocale(), { month: "2-digit", day: "2-digit" }).format(ts);
}

/** HH:MM */
export function formatTime(ts: number): string {
  return new Intl.DateTimeFormat(getLocale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ts);
}

/** Calendar keys are parsed as local dates, never UTC timestamps. */
export function formatDateKey(key: string, includeYear = true): string {
  const [year = 0, month = 1, day = 1] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(getLocale(), {
    ...(includeYear ? { year: "numeric" as const } : {}),
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(year, month - 1, day));
}

/** 文件大小：1.5MB / 200KB / 800B */
export function formatFileSize(size: number): string {
  const number = (value: number, digits = 0) =>
    new Intl.NumberFormat(getLocale(), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: false,
    }).format(value);
  if (size >= 1024 * 1024) return `${number(size / (1024 * 1024), 1)}MB`;
  if (size >= 1024) return `${number(Math.round(size / 1024))}KB`;
  return `${number(size)}B`;
}

/** 紧凑 token 计数：385k / 1.0M（上下文占用与压缩提示共用） */
export function formatCompact(n: number): string {
  const number = (value: number, digits = 0) =>
    new Intl.NumberFormat(getLocale(), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: false,
    }).format(value);
  if (n >= 1_000_000) return `${number(n / 1_000_000, 1)}M`;
  if (n >= 1_000) return `${number(Math.round(n / 1_000))}k`;
  return new Intl.NumberFormat(getLocale(), { useGrouping: false, maximumFractionDigits: 20 }).format(n);
}
