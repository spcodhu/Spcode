import { describe, expect, it } from "vitest";
import { WindowCloseController } from "../src/main/window-close.js";

describe("Windows 窗口关闭确认", () => {
  it("macOS 和其他平台保持直接关闭", () => {
    const controller = new WindowCloseController();
    expect(controller.request("darwin")).toBe("allow");
    expect(controller.request("linux")).toBe("allow");
    expect(controller.resolve("quit")).toBe("ignore");
  });

  it("重复点叉不重复弹窗，取消后可重新确认", () => {
    const controller = new WindowCloseController();
    expect(controller.request("win32")).toBe("confirm");
    expect(controller.request("win32")).toBe("wait");
    expect(controller.resolve("cancel")).toBe("cancel");
    expect(controller.resolve("cancel")).toBe("ignore");
    expect(controller.request("win32")).toBe("confirm");
  });

  it("最小化只关闭本次确认，下一次点叉仍需确认", () => {
    const controller = new WindowCloseController();
    expect(controller.request("win32")).toBe("confirm");
    expect(controller.resolve("minimize")).toBe("minimize");
    expect(controller.request("win32")).toBe("confirm");
  });

  it("只有确认完全关闭后才放行窗口关闭", () => {
    const controller = new WindowCloseController();
    expect(controller.request("win32")).toBe("confirm");
    expect(controller.resolve("quit")).toBe("quit");
    expect(controller.request("win32")).toBe("allow");
  });

  it("应用主动退出和自动更新不被确认框阻断", () => {
    const controller = new WindowCloseController();
    expect(controller.request("win32")).toBe("confirm");
    controller.allowWithoutConfirmation();
    expect(controller.request("win32")).toBe("allow");
  });
});
