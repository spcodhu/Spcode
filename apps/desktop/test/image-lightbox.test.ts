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
    const first = document.querySelector('[data-testid="image-preview-image"]')!;
    const cancelled = first.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(cancelled).toBe(false);
    expect(state.open).toHaveBeenLastCalledWith(images[0]);

    await render(1);
    const second = document.querySelector('[data-testid="image-preview-image"]')!;
    second.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(state.open).toHaveBeenLastCalledWith(images[1]);
    expect(state.open).toHaveBeenCalledTimes(2);
  });
});

describe("图片灯箱缩放与切换", () => {
  it("放大缩小按钮更新百分比，切图后恢复 100%", async () => {
    const onNavigate = vi.fn();
    await act(async () =>
      root.render(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(ImageLightbox, { images, index: 0, onClose: vi.fn(), onNavigate }),
        ),
      ),
    );
    const zoomReset = () => document.querySelector('[data-testid="image-preview-zoom-reset"]')!;
    expect(zoomReset().textContent).toBe("100%");
    expect(document.querySelector<HTMLButtonElement>('[data-testid="image-preview-prev"]')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-testid="image-preview-next"]')!.disabled).toBe(false);

    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="image-preview-zoom-in"]')!.click());
    expect(zoomReset().textContent).toBe("125%");
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="image-preview-zoom-out"]')!.click());
    expect(zoomReset().textContent).toBe("100%");

    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="image-preview-zoom-in"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="image-preview-next"]')!.click());
    expect(onNavigate).toHaveBeenCalledWith(1);
    await act(async () =>
      root.render(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(ImageLightbox, { images, index: 1, onClose: vi.fn(), onNavigate }),
        ),
      ),
    );
    expect(zoomReset().textContent).toBe("100%");
    expect(document.querySelector<HTMLButtonElement>('[data-testid="image-preview-next"]')!.disabled).toBe(true);
  });

  it("键盘 +/- 缩放，0 复位", async () => {
    await render(0);
    const zoomReset = () => document.querySelector('[data-testid="image-preview-zoom-reset"]')!;
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true, cancelable: true }));
    });
    expect(zoomReset().textContent).toBe("125%");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "-", bubbles: true, cancelable: true }));
    });
    expect(zoomReset().textContent).toBe("100%");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true, cancelable: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true, cancelable: true }));
    });
    expect(zoomReset().textContent).toBe("100%");
  });
});
