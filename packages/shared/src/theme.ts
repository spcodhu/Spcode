export type ThemeBase = "dark" | "light";

export const THEME_TOKEN_KEYS = [
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
  "onAccent",
  "onDanger",
  "accentDim",
  "accentSoft",
  "danger",
  "warning",
  "success",
  "userBubble",
  "thinking",
] as const;

export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];
export type ThemeColors = Partial<Record<ThemeTokenKey, string>>;

export interface BuiltInTheme {
  id: "spcode-light" | "spcode-dark";
  base: ThemeBase;
  colors: Required<ThemeColors>;
}

/**
 * Codex 风格的中性、低装饰色板。主操作只使用黑/白反色，
 * 红/琥珀/绿仅表达真实状态，不承担品牌装饰。
 */
export const BUILT_IN_THEMES: Record<BuiltInTheme["id"], BuiltInTheme> = {
  "spcode-light": {
    id: "spcode-light",
    base: "light",
    colors: {
      bgRoot: "#F7F7F5",
      bgSidebar: "#F0F0EE",
      bgMain: "#FFFFFF",
      bgElevated: "#FFFFFF",
      bgHover: "#EEEEEC",
      bgActive: "#E6E6E3",
      border: "#E2E2DE",
      borderStrong: "#CFCFCA",
      textPrimary: "#1C1C1C",
      textSecondary: "#616161",
      textTertiary: "#737371",
      accent: "#171717",
      onAccent: "#FFFFFF",
      onDanger: "#FFFFFF",
      accentDim: "#3D3D3D",
      accentSoft: "rgba(0, 0, 0, 0.06)",
      danger: "#C94B57",
      warning: "#A86F16",
      success: "#2E7D52",
      userBubble: "#F0F0ED",
      thinking: "#6F6F6F",
    },
  },
  "spcode-dark": {
    id: "spcode-dark",
    base: "dark",
    colors: {
      bgRoot: "#101012",
      bgSidebar: "#161618",
      bgMain: "#1B1B1E",
      bgElevated: "#232327",
      bgHover: "#2A2A2F",
      bgActive: "#333339",
      border: "#343439",
      borderStrong: "#4B4B52",
      textPrimary: "#F0F0F2",
      textSecondary: "#B0B0B8",
      textTertiary: "#8E8E98",
      accent: "#F4F4F5",
      onAccent: "#18181A",
      onDanger: "#1B1012",
      accentDim: "#D6D6DA",
      accentSoft: "rgba(255, 255, 255, 0.08)",
      danger: "#EC6B78",
      warning: "#DEA74E",
      success: "#63BE84",
      userBubble: "#28282D",
      thinking: "#9C9CA6",
    },
  },
};

export function isBuiltInThemeId(value: unknown): value is BuiltInTheme["id"] {
  return value === "spcode-light" || value === "spcode-dark";
}
