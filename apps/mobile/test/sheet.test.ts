/** @vitest-environment jsdom */
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "../src/components/Sheet.js";

let appRoot: HTMLDivElement;
let mount: HTMLDivElement;
let trigger: HTMLButtonElement;
let root: Root | null;
let onClose: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  appRoot = document.createElement("div");
  appRoot.id = "root";
  mount = document.createElement("div");
  trigger = document.createElement("button");
  trigger.textContent = "打开";
  appRoot.append(trigger, mount);
  document.body.append(appRoot);
  trigger.focus();
  root = createRoot(mount);
  onClose = vi.fn();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  appRoot.remove();
  vi.unstubAllGlobals();
});

async function render(busy = false) {
  await act(async () =>
    root!.render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          Sheet,
          {
            title: "测试面板",
            onClose,
            busy,
            footer: createElement("button", { type: "button", "data-testid": "last" }, "完成"),
          },
          createElement("input", { "data-testid": "field" }),
        ),
      ),
    ),
  );
}

function dialog(): HTMLElement {
  return document.querySelector('[role="dialog"]')!;
}

describe("移动端 Sheet", () => {
  it("圈定焦点、Esc 关闭并恢复触发点与背景", async () => {
    await render();
    expect(appRoot.inert).toBe(true);
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    const close = document.querySelector<HTMLButtonElement>("[data-sheet-close]")!;
    const last = document.querySelector<HTMLButtonElement>('[data-testid="last"]')!;

    await act(async () => last.focus());
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(close);
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(last);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => root!.unmount());
    root = null;
    expect(appRoot.inert).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("busy 时禁用关闭，遮罩与 Esc 都不会误关", async () => {
    await render(true);
    expect(document.querySelector<HTMLButtonElement>("[data-sheet-close]")!.disabled).toBe(true);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    document.querySelector<HTMLElement>('[data-testid="sheet-backdrop"]')!.click();
    expect(onClose).not.toHaveBeenCalled();
  });
});
