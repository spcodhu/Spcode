/** @vitest-environment jsdom */
import { setLocale } from "@spcode/shared/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openImageContextMenu } from "../src/renderer/src/image-actions.js";
import { useStore } from "../src/renderer/src/store.js";

const image = { name: "pixel.png", mimeType: "image/png", data: "AAAA" };
let showMenu: ReturnType<typeof vi.fn>;
beforeEach(() => {
  setLocale("zh-CN");
  showMenu = vi.fn();
  Object.defineProperty(window, "spcode", { configurable: true, value: { showImageContextMenu: showMenu } });
  useStore.setState({ notice: null, lastError: null });
});
afterEach(() => {
  Reflect.deleteProperty(window, "spcode");
  useStore.setState({ notice: null, lastError: null });
});

describe("图片菜单结果反馈", () => {
  it("复制与保存显示成功提示，取消保持安静", async () => {
    showMenu.mockResolvedValueOnce({ type: "copied" });
    await openImageContextMenu(image);
    expect(useStore.getState().notice).toEqual({ text: "已复制图片", tone: "success" });

    showMenu.mockResolvedValueOnce({ type: "saved", path: "/tmp/pixel.png" });
    await openImageContextMenu(image);
    expect(useStore.getState().notice?.text).toBe("图片已保存");

    useStore.setState({ notice: null });
    showMenu.mockResolvedValueOnce({ type: "cancelled" });
    await openImageContextMenu(image);
    expect(useStore.getState().notice).toBeNull();
  });

  it("失败展示真实错误原因", async () => {
    showMenu.mockRejectedValue(new Error("clipboard unavailable"));
    await openImageContextMenu(image);
    expect(useStore.getState().lastError).toBe("图片操作失败：clipboard unavailable");
    expect(useStore.getState().notice).toBeNull();
  });
});
