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
      textTertiary: "#7A7A78",
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
      bgRoot: "#121212",
      bgSidebar: "#181818",
      bgMain: "#1F1F1F",
      bgElevated: "#262626",
      bgHover: "#2C2C2C",
      bgActive: "#343434",
      border: "#363636",
      borderStrong: "#4A4A4A",
      textPrimary: "#ECECEC",
      textSecondary: "#A3A3A3",
      textTertiary: "#858585",
      accent: "#F2F2F2",
      onAccent: "#171717",
      onDanger: "#1B1012",
      accentDim: "#D4D4D4",
      accentSoft: "rgba(255, 255, 255, 0.09)",
      danger: "#E5636F",
      warning: "#D9A045",
      success: "#5CB87A",
      userBubble: "#292929",
      thinking: "#969696",
    },
  },
};

export function isBuiltInThemeId(value: unknown): value is BuiltInTheme["id"] {
  return value === "spcode-light" || value === "spcode-dark";
}
