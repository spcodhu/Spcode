import { describe, expect, it } from "vitest";
import { shouldReserveTrafficLightInset } from "../src/renderer/src/window-chrome.js";

describe("macOS 红绿灯 inset", () => {
  it("仅 macOS 非全屏预留；全屏后立即取消", () => {
    expect(shouldReserveTrafficLightInset({ platform: "darwin", fullScreen: false })).toBe(true);
    expect(shouldReserveTrafficLightInset({ platform: "darwin", fullScreen: true })).toBe(false);
  });

  it("其他平台从不预留 macOS 红绿灯空间", () => {
    expect(shouldReserveTrafficLightInset({ platform: "win32", fullScreen: false })).toBe(false);
    expect(shouldReserveTrafficLightInset({ platform: "linux", fullScreen: false })).toBe(false);
  });
});
