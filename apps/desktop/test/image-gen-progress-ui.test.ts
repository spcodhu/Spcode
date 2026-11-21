/** @vitest-environment jsdom */
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageGenProgress } from "../src/renderer/src/components/ImageGenProgress.js";

let root: Root;
let mount: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
});

afterEach(async () => {
  await act(async () => root.unmount());
  mount.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setLocale("zh-CN");
});

function element(id: string): HTMLElement {
  const found = mount.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`);
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe("生图等待卡片", () => {
  it("使用 16:10 横向卡片，完整标题与等待时间分行，不展示同步说明", async () => {
    vi.useFakeTimers();
    await act(async () =>
      root.render(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(ImageGenProgress, {
            title: "正在生成图片…",
            description: "同步生图中，可与其他工具并行执行",
            testId: "generated-image-progress",
            variant: "card",
          }),
        ),
      ),
    );

    const card = element("generated-image-progress");
    const title = element("generated-image-progress-title");
    const elapsed = element("generated-image-progress-elapsed");
    expect(card.className).toContain("aspect-[16/10]");
    expect(title.textContent).toBe("正在生成图片…");
    expect(title.className).not.toContain("truncate");
    expect(title.nextElementSibling).toBe(elapsed);
    expect(elapsed.className).toContain("block");
    expect(card.textContent).not.toContain("同步生图中");

    await act(async () => vi.advanceTimersByTime(13_000));
    expect(elapsed.textContent).toBe("已等待 13 秒");
  });
});
