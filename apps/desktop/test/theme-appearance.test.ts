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
    expect(document.documentElement.dataset.themeBase).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--color-bg-root")).toBe("#F7F7F5");
    expect(document.documentElement.style.getPropertyValue("--color-on-accent")).toBe("#FFFFFF");
  });

  it("内置暗色完整注入，自定义主题只覆盖指定令牌", () => {
    applyTheme(null, "spcode-dark");
    expect(document.documentElement.dataset.themeBase).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--color-bg-root")).toBe("#121212");
    expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("#F2F2F2");

    applyTheme({ name: "仅覆盖", base: "dark", colors: { accent: "#123456" } }, "spcode-dark");
    expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("#123456");
    expect(document.documentElement.style.getPropertyValue("--color-bg-root")).toBe("#121212");
  });
});
