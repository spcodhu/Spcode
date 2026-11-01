/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { applyMobileTheme, initializeMobileTheme, readMobileTheme, setMobileTheme } from "../src/lib/theme";
import { useAppStore } from "../src/state/store";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme-base");
  document.documentElement.style.colorScheme = "";
  useAppStore.getState().reset();
});

describe("手机亮暗主题", () => {
  it("默认亮色，暗色注入共享令牌并写回本机偏好", () => {
    expect(readMobileTheme()).toBe("light");
    expect(initializeMobileTheme()).toBe("light");

    setMobileTheme("dark");
    expect(readMobileTheme()).toBe("dark");
    expect(localStorage.getItem("spcod-mobile-theme")).toBe("dark");
    expect(document.documentElement.dataset.themeBase).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--color-bg-root")).toBe("#101012");
    expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("#F4F4F5");

    applyMobileTheme("light");
    expect(document.documentElement.style.getPropertyValue("--color-bg-root")).toBe("#F7F7F5");
  });

  it("store 开关同时更新渲染状态、DOM 和持久化，reset 不清除用户偏好", () => {
    useAppStore.getState().setThemeBase("dark");
    expect(useAppStore.getState().themeBase).toBe("dark");
    expect(document.documentElement.dataset.themeBase).toBe("dark");

    useAppStore.getState().reset();
    expect(useAppStore.getState().themeBase).toBe("dark");
    useAppStore.getState().setThemeBase("light");
    expect(localStorage.getItem("spcod-mobile-theme")).toBe("light");
  });
});
