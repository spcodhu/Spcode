import { describe, expect, it } from "vitest";
import { normalizeTheme } from "../src/renderer/src/theme.js";

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
});
