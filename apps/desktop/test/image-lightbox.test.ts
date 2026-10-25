/** @vitest-environment jsdom */
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageLightbox } from "../src/renderer/src/components/ImageLightbox.js";

const state = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../src/renderer/src/image-actions", () => ({ openImageContextMenu: state.open }));

const images = [
  { name: "first.png", mimeType: "image/png", data: "first" },
  { name: "second.png", mimeType: "image/png", data: "second" },
];
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  state.open.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(index: number) {
  await act(async () =>
    root.render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(ImageLightbox, { images, index, onClose: vi.fn(), onNavigate: vi.fn() }),
      ),
    ),
  );
}

describe("图片灯箱右键", () => {
  it("阻止浏览器默认菜单并对当前图片调用原生菜单", async () => {
    await render(0);
    const first = container.querySelector('[data-testid="image-preview-image"]')!;
    const cancelled = first.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(cancelled).toBe(false);
    expect(state.open).toHaveBeenLastCalledWith(images[0]);

    await render(1);
    const second = container.querySelector('[data-testid="image-preview-image"]')!;
    second.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(state.open).toHaveBeenLastCalledWith(images[1]);
    expect(state.open).toHaveBeenCalledTimes(2);
  });
});
