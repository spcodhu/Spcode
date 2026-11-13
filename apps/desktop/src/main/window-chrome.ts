import type { AppSettings } from "@spcode/shared";
import { BUILT_IN_THEMES, isBuiltInThemeId } from "@spcode/shared/theme";
import type { BrowserWindowConstructorOptions } from "electron";

export type WindowThemeSettings = Pick<AppSettings, "themeId" | "customTheme">;

type NativeWindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  "autoHideMenuBar" | "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

/** Windows 原生窗口按钮嵌入应用顶栏，颜色与渲染层实际主题保持一致。 */
export function windowsTitleBarOverlay(settings: WindowThemeSettings): {
  color: string;
  symbolColor: string;
  height: number;
} {
  const selectedId = isBuiltInThemeId(settings.themeId) ? settings.themeId : "spcode-light";
  const base = settings.customTheme?.base ?? BUILT_IN_THEMES[selectedId].base;
  const builtIn = BUILT_IN_THEMES[base === "dark" ? "spcode-dark" : "spcode-light"];
  const colors = { ...builtIn.colors, ...settings.customTheme?.colors };
  return { color: colors.bgMain, symbolColor: colors.textSecondary, height: 48 };
}

/** hiddenInset 仅属于 macOS；Windows 必须 hidden + overlay，否则会回退出原生白条和菜单。 */
export function nativeWindowChromeOptions(
  platform: NodeJS.Platform,
  settings: WindowThemeSettings,
): NativeWindowChromeOptions {
  if (platform === "win32") {
    return {
      autoHideMenuBar: true,
      titleBarStyle: "hidden",
      titleBarOverlay: windowsTitleBarOverlay(settings),
    };
  }
  return {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
  };
}
