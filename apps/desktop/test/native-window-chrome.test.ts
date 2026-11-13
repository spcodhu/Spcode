import { DEFAULT_SETTINGS } from "@spcode/shared";
import { describe, expect, it } from "vitest";
import { nativeWindowChromeOptions, windowsTitleBarOverlay } from "../src/main/window-chrome.js";

describe("原生窗口标题栏", () => {
  it("Windows 隐藏原生标题栏与菜单，并将窗口按钮嵌入 48px 应用顶栏", () => {
    expect(nativeWindowChromeOptions("win32", DEFAULT_SETTINGS)).toEqual({
      autoHideMenuBar: true,
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#FFFFFF", symbolColor: "#616161", height: 48 },
    });
  });

  it("macOS 保持 hiddenInset 与原有红绿灯位置", () => {
    expect(nativeWindowChromeOptions("darwin", DEFAULT_SETTINGS)).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 14 },
    });
  });

  it("窗口按钮跟随内置暗色主题", () => {
    expect(windowsTitleBarOverlay({ ...DEFAULT_SETTINGS, themeId: "spcode-dark" })).toEqual({
      color: "#1B1B1E",
      symbolColor: "#B0B0B8",
      height: 48,
    });
  });

  it("自定义主题覆盖窗口按钮颜色，未覆盖项沿用其明暗基底", () => {
    expect(
      windowsTitleBarOverlay({
        themeId: "spcode-light",
        customTheme: {
          name: "测试暗色",
          base: "dark",
          colors: { bgMain: "#112233" },
        },
      }),
    ).toEqual({ color: "#112233", symbolColor: "#B0B0B8", height: 48 });
  });

  it("Modal 打开时，窗口按钮背景与 black/55 网页遮罩一致", () => {
    expect(windowsTitleBarOverlay(DEFAULT_SETTINGS, true)).toEqual({
      color: "#737373",
      symbolColor: "#FFFFFF",
      height: 48,
    });
    expect(windowsTitleBarOverlay({ ...DEFAULT_SETTINGS, themeId: "spcode-dark" }, true)).toEqual({
      color: "#0C0C0E",
      symbolColor: "#FFFFFF",
      height: 48,
    });
  });

  it("Modal 遮罩支持自定义十六进制与 RGB 主题色", () => {
    expect(
      windowsTitleBarOverlay(
        {
          themeId: "spcode-light",
          customTheme: { name: "自定义", base: "light", colors: { bgMain: "#112233" } },
        },
        true,
      ).color,
    ).toBe("#080F17");
    expect(
      windowsTitleBarOverlay(
        {
          themeId: "spcode-light",
          customTheme: { name: "RGB", base: "light", colors: { bgMain: "rgb(255, 255, 255)" } },
        },
        true,
      ).color,
    ).toBe("#737373");
  });
});
