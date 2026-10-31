import { describe, expect, it } from "vitest";
import { BUILT_IN_THEMES } from "@spcode/shared/theme";
import { contrastRatio, normalizeTheme, validateGeneratedTheme } from "../src/renderer/src/theme.js";

describe("normalizeTheme", () => {
  it("接受合法主题并保留白名单令牌", () => {
    const theme = normalizeTheme({
      name: "深林",
      base: "dark",
      colors: {
        bgRoot: "#0b1410",
        accent: "#3ec68f",
        hacker: "evil", // 非白名单键被丢弃
      },
    });
    expect(theme).not.toBeNull();
    expect(theme?.name).toBe("深林");
    expect(theme?.colors.bgRoot).toBe("#0b1410");
    expect("hacker" in (theme?.colors ?? {})).toBe(false);
  });

  it("拒绝非法输入", () => {
    expect(normalizeTheme(null)).toBeNull();
    expect(normalizeTheme({})).toBeNull();
    expect(normalizeTheme({ name: "x" })).toBeNull();
    expect(normalizeTheme({ name: "x", base: "dark", colors: {} })).toBeNull();
    expect(normalizeTheme({ name: "x", base: "dark", colors: { bgRoot: "not-a-color!!" } })).toBeNull();
  });

  it("base 非法值归一为 dark", () => {
    const theme = normalizeTheme({ name: "x", base: "purple", colors: { accent: "#fff" } });
    expect(theme?.base).toBe("dark");
  });

  it("AI 主题要求核心令牌与 WCAG AA 对比度，内置双主题均达标", () => {
    expect(BUILT_IN_THEMES["spcode-light"].colors.textPrimary).toBeTruthy();
    for (const theme of Object.values(BUILT_IN_THEMES)) {
      expect(contrastRatio(theme.colors.textPrimary, theme.colors.bgMain)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.colors.onAccent, theme.colors.accent)).toBeGreaterThanOrEqual(4.5);
    }
    expect(
      validateGeneratedTheme({
        name: "低对比",
        base: "light",
        colors: {
          bgRoot: "#ffffff",
          bgMain: "#ffffff",
          bgElevated: "#ffffff",
          textPrimary: "#eeeeee",
          textSecondary: "#777777",
          accent: "#ffffff",
          onAccent: "#ffffff",
        },
      }),
    ).toEqual(["contrast:textPrimary/bgMain", "contrast:onAccent/accent"]);
  });
});
