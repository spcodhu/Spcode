import type { AppSettings } from "@spcode/shared";
import { BUILT_IN_THEMES, isBuiltInThemeId } from "@spcode/shared/theme";
import type { BrowserWindowConstructorOptions } from "electron";

export type WindowThemeSettings = Pick<AppSettings, "themeId" | "customTheme">;

type NativeWindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  "autoHideMenuBar" | "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

/** 把网页 Modal 的 black/55 遮罩合成到原生窗口按钮背景。 */
function dimTitleBarColor(value: string): string | null {
  const hex = value.trim().match(/^#([0-9a-f]{3,8})$/i)?.[1];
  if (hex && ![3, 4, 6, 8].includes(hex.length)) return null;
  let channels: number[] | null = null;
  if (hex) {
    const full = hex.length <= 4 ? [...hex.slice(0, 3)].map((c) => c + c).join("") : hex.slice(0, 6);
    channels = [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16));
  } else {
    const rgb = value.trim().match(/^rgba?\(\s*([\d.]+%?)[,\s]+([\d.]+%?)[,\s]+([\d.]+%?)/i);
    if (rgb) {
      channels = rgb.slice(1, 4).map((part) => {
        const percent = part.endsWith("%");
        const parsed = Number.parseFloat(part);
        return percent ? (parsed / 100) * 255 : parsed;
      });
    }
  }
  if (!channels || channels.some((channel) => !Number.isFinite(channel))) return null;
  const dimmed = channels.map((channel) => Math.round(Math.max(0, Math.min(255, channel)) * 0.45));
  return `#${dimmed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** Windows 原生窗口按钮嵌入应用顶栏，颜色与渲染层实际主题及 Modal 遮罩保持一致。 */
export function windowsTitleBarOverlay(
  settings: WindowThemeSettings,
  modalOpen = false,
): {
  color: string;
  symbolColor: string;
  height: number;
} {
  const selectedId = isBuiltInThemeId(settings.themeId) ? settings.themeId : "spcode-light";
  const base = settings.customTheme?.base ?? BUILT_IN_THEMES[selectedId].base;
  const builtIn = BUILT_IN_THEMES[base === "dark" ? "spcode-dark" : "spcode-light"];
  const colors = { ...builtIn.colors, ...settings.customTheme?.colors };
  if (modalOpen) {
    return {
      color: dimTitleBarColor(colors.bgMain) ?? dimTitleBarColor(builtIn.colors.bgMain)!,
      symbolColor: "#FFFFFF",
      height: 48,
    };
  }
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
