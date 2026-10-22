/**
 * 外观引擎（渲染进程）：
 * - applyTheme: 把 customTheme.colors 覆盖到 CSS 变量（--color-*）上
 * - applyFonts: 用 FontFace API 从主进程给的字体数据注册字体族
 *
 * 主题 JSON 是换肤/AI 生成/手工编写的统一格式：
 * { name, base: "dark"|"light", colors: { bgRoot: "#0b0f14", accent: "#3ec6b8", ... } }
 * colors 的键是 camelCase 设计令牌，映射到 --color-<kebab>。
 */
import type { AppSettings, CustomTheme } from "@spcode/shared";
import { i18n } from "@spcode/shared/i18n";

/** 允许覆盖的设计令牌（与 styles.css @theme 里的变量一一对应） */
const THEME_KEYS = [
  "bgRoot",
  "bgSidebar",
  "bgMain",
  "bgElevated",
  "bgHover",
  "bgActive",
  "border",
  "borderStrong",
  "textPrimary",
  "textSecondary",
  "textTertiary",
  "accent",
  "accentDim",
  "accentSoft",
  "danger",
  "warning",
  "success",
  "userBubble",
  "thinking",
] as const;

function toKebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** 校验并规范化主题对象；非法返回 null */
export function normalizeTheme(raw: unknown): CustomTheme | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.name !== "string" || !t.name) return null;
  const base = t.base === "light" ? "light" : "dark";
  const colors: Record<string, string> = {};
  const rawColors = t.colors;
  if (!rawColors || typeof rawColors !== "object") return null;
  for (const [k, v] of Object.entries(rawColors as Record<string, unknown>)) {
    if (typeof v === "string" && (THEME_KEYS as readonly string[]).includes(k) && isColor(v)) {
      colors[k] = v;
    }
  }
  if (Object.keys(colors).length === 0) return null;
  return { name: t.name, base, colors };
}

function isColor(v: string): boolean {
  return /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i.test(v.trim());
}

/** 把主题 colors 写到 :root 的 CSS 变量上；theme 为 null 时清除覆盖恢复默认 */
export function applyTheme(theme: CustomTheme | null): void {
  const root = document.documentElement;
  // 先清掉所有可能残留的主题变量
  for (const key of THEME_KEYS) root.style.removeProperty(`--color-${toKebab(key)}`);
  if (!theme) return;
  for (const [k, v] of Object.entries(theme.colors)) {
    root.style.setProperty(`--color-${toKebab(k)}`, v);
  }
}

// ---------------------------------------------------------------------------
// 字体
// ---------------------------------------------------------------------------

const registeredFonts = new Set<string>();

/** 从字体文件注册字体族；重复注册自动跳过 */
export async function registerFont(family: string, fileName: string): Promise<boolean> {
  if (!family || registeredFonts.has(family)) return true;
  try {
    const data = await window.spcode.getFontData(fileName);
    if (!data) return false;
    // IPC 结构化克隆给的是 Uint8Array 视图，FontFace 需要独立 ArrayBuffer
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

/** 应用 UI/等宽字体选择（写入 CSS 变量） */
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

/** 启动时应用全部外观设置 */
export async function applyAppearance(settings: AppSettings): Promise<void> {
  applyTheme(settings.customTheme);
  if (settings.uiFontFile) await registerFont(settings.uiFontFamily, settings.uiFontFile);
  if (settings.monoFontFile) await registerFont(settings.monoFontFamily, settings.monoFontFile);
  applyFontFamilies(settings);
}
