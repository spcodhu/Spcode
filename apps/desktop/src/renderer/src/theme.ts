/**
 * 外观引擎：内置亮/暗色板 + 自定义主题覆盖 + 字体。
 * 主题 JSON：{ name, base: "dark"|"light", colors: { bgRoot: "#fff", ... } }。
 */
import type { AppSettings, CustomTheme } from "@spcode/shared";
import { i18n } from "@spcode/shared/i18n";
import { BUILT_IN_THEMES, isBuiltInThemeId, THEME_TOKEN_KEYS, type ThemeBase } from "@spcode/shared/theme";

function toKebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** 当前实际明暗基底：自定义主题优先，否则由内置 themeId 决定。 */
export function resolveThemeBase(settings: AppSettings | null): ThemeBase {
  if (settings?.customTheme) return settings.customTheme.base;
  return settings?.themeId === "spcode-dark" ? "dark" : "light";
}

/** 校验并规范化主题对象；非法返回 null。 */
export function normalizeTheme(raw: unknown): CustomTheme | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.name !== "string" || !t.name) return null;
  const base = t.base === "light" ? "light" : "dark";
  const colors: Record<string, string> = {};
  const rawColors = t.colors;
  if (!rawColors || typeof rawColors !== "object") return null;
  for (const [k, v] of Object.entries(rawColors as Record<string, unknown>)) {
    if (typeof v === "string" && (THEME_TOKEN_KEYS as readonly string[]).includes(k) && isColor(v)) {
      colors[k] = v;
    }
  }
  if (Object.keys(colors).length === 0) return null;
  return { name: t.name, base, colors };
}

function isColor(v: string): boolean {
  return /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i.test(v.trim());
}

/** WCAG 相对亮度对比度；用于 AI 主题入口校验与内置色板回归。 */
export function contrastRatio(first: string, second: string): number {
  const luminance = (hex: string): number => {
    const value = hex.trim().replace(/^#/, "");
    const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value.slice(0, 6);
    if (!/^[0-9a-f]{6}$/i.test(full)) return 0;
    const channels = [0, 2, 4].map((offset) => {
      const c = Number.parseInt(full.slice(offset, offset + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  };
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** AI 生成主题必须包含核心令牌，且正文和主操作达到 WCAG AA。 */
export function validateGeneratedTheme(theme: CustomTheme): string[] {
  const required = ["bgRoot", "bgMain", "bgElevated", "textPrimary", "textSecondary", "accent", "onAccent"] as const;
  const issues = required.filter((key) => !(key in theme.colors)).map((key) => `missing:${key}`);
  if (issues.length > 0) return issues;
  if (contrastRatio(theme.colors.textPrimary!, theme.colors.bgMain!) < 4.5) issues.push("contrast:textPrimary/bgMain");
  if (contrastRatio(theme.colors.onAccent!, theme.colors.accent!) < 4.5) issues.push("contrast:onAccent/accent");
  return issues;
}

/** 先应用完整内置色板，再叠加自定义 colors；所有组件和 Markdown 共用同一结果。 */
export function applyTheme(theme: CustomTheme | null, themeId = "spcode-light"): void {
  const root = document.documentElement;
  for (const key of THEME_TOKEN_KEYS) root.style.removeProperty(`--color-${toKebab(key)}`);
  const builtInId = isBuiltInThemeId(themeId) ? themeId : "spcode-light";
  const builtIn = BUILT_IN_THEMES[builtInId];
  const base = theme?.base ?? builtIn.base;
  root.dataset.themeBase = base;
  root.style.colorScheme = base;
  for (const [k, v] of Object.entries(builtIn.colors)) {
    root.style.setProperty(`--color-${toKebab(k)}`, v);
  }
  if (theme) {
    for (const [k, v] of Object.entries(theme.colors)) {
      root.style.setProperty(`--color-${toKebab(k)}`, v);
    }
  }
}

// ---------------------------------------------------------------------------
// 字体
// ---------------------------------------------------------------------------

const registeredFonts = new Set<string>();

export async function registerFont(family: string, fileName: string): Promise<boolean> {
  if (!family || registeredFonts.has(family)) return true;
  try {
    const data = await window.spcode.getFontData(fileName);
    if (!data) return false;
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const face = new FontFace(family, buf);
    await face.load();
    document.fonts.add(face);
    registeredFonts.add(family);
    return true;
  } catch (e) {
    console.warn(i18n.t("settings:appearance.fontFailed", { name: family }), e);
    return false;
  }
}

export function applyFontFamilies(settings: AppSettings): void {
  const root = document.documentElement;
  if (settings.uiFontFamily) {
    root.style.setProperty("--ui-font", `"${settings.uiFontFamily}", "PingFang SC", sans-serif`);
  } else {
    root.style.removeProperty("--ui-font");
  }
  if (settings.monoFontFamily) {
    root.style.setProperty("--mono-font", `"${settings.monoFontFamily}", "SF Mono", monospace`);
  } else {
    root.style.removeProperty("--mono-font");
  }
}

export async function applyAppearance(settings: AppSettings): Promise<void> {
  applyTheme(settings.customTheme, settings.themeId);
  if (settings.uiFontFile) await registerFont(settings.uiFontFamily, settings.uiFontFile);
  if (settings.monoFontFile) await registerFont(settings.monoFontFamily, settings.monoFontFile);
  applyFontFamilies(settings);
}
