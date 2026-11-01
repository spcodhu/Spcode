import type { WindowChromeState } from "@spcode/shared";

/** 只有 macOS 非全屏才显示左上角红绿灯；全屏和其他平台不预留这块空间。 */
export function shouldReserveTrafficLightInset(chrome: Pick<WindowChromeState, "platform" | "fullScreen">): boolean {
  return chrome.platform === "darwin" && !chrome.fullScreen;
}
