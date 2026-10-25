/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { applyTheme } from "../src/renderer/src/theme.js";

afterEach(() => {
  applyTheme(null);
  document.documentElement.removeAttribute("data-theme-base");
});

describe("applyTheme", () => {
  it("同步浅色主题基色、color-scheme 与自定义令牌，并在恢复默认时清理", () => {
    applyTheme({ name: "浅色", base: "light", colors: { bgRoot: "#ffffff", onAccent: "#102010" } });
    expect(document.documentElement.dataset.themeBase).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--color-bg-root")).toBe("#ffffff");
    expect(document.documentElement.style.getPropertyValue("--color-on-accent")).toBe("#102010");

    applyTheme(null);
    expect(document.documentElement.dataset.themeBase).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--color-bg-root")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--color-on-accent")).toBe("");
  });
});
