/** @vitest-environment jsdom */
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastRegion } from "../src/renderer/src/components/ToastRegion.js";
import { useStore } from "../src/renderer/src/store.js";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  useStore.setState({ notice: { text: "普通通知", tone: "success" }, lastError: "错误明细" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useStore.setState({ notice: null, lastError: null });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ToastRegion", () => {
  it("通知与错误堆叠，悬浮暂停计时，离开后分别到期", async () => {
    await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(ToastRegion))));
    const region = container.querySelector('[data-testid="toast-region"]')!;
    expect(region.querySelector('[role="status"]')?.textContent).toContain("普通通知");
    expect(region.querySelector('[role="alert"]')?.textContent).toContain("错误明细");

    await act(async () => {
      region.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(useStore.getState().notice).not.toBeNull();
    expect(useStore.getState().lastError).not.toBeNull();

    await act(async () => {
      region.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    expect(useStore.getState().lastError).toBeNull();
    expect(useStore.getState().notice).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(2000));
    expect(useStore.getState().notice).toBeNull();
  });
});
