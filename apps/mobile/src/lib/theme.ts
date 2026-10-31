import { BUILT_IN_THEMES, THEME_TOKEN_KEYS, type ThemeBase } from "@spcode/shared/theme";

const STORAGE_KEY = "spcod-mobile-theme";

function toKebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

export function readMobileTheme(): ThemeBase {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** 注入与桌面一致的设计令牌；localStorage 不可用时仍保持当前页主题。 */
export function applyMobileTheme(base: ThemeBase): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const theme = BUILT_IN_THEMES[base === "dark" ? "spcode-dark" : "spcode-light"];
  root.dataset.themeBase = base;
  root.style.colorScheme = base;
  for (const key of THEME_TOKEN_KEYS) {
    root.style.setProperty(`--color-${toKebab(key)}`, theme.colors[key]);
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.colors.bgMain);
}

export function setMobileTheme(base: ThemeBase): void {
  applyMobileTheme(base);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, base);
  } catch {
    // 隐私模式禁用存储时只保留本次页面内的主题。
  }
}

export function initializeMobileTheme(): ThemeBase {
  const base = readMobileTheme();
  applyMobileTheme(base);
  return base;
}
