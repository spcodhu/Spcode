/** @vitest-environment jsdom */
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "../src/renderer/src/components/ui/Modal.js";

let appRoot: HTMLDivElement;
let mount: HTMLDivElement;
let trigger: HTMLButtonElement;
let root: Root | null;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  appRoot = document.createElement("div");
  appRoot.id = "root";
  mount = document.createElement("div");
  trigger = document.createElement("button");
  trigger.textContent = "打开";
  appRoot.append(trigger, mount);
  document.body.append(appRoot);
  trigger.focus();
  root = createRoot(mount);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  appRoot.remove();
  vi.unstubAllGlobals();
});

function StackExample() {
  const [first, setFirst] = useState(true);
  const [second, setSecond] = useState(true);
  return createElement(
    "div",
    null,
    first &&
      createElement(
        Modal,
        { title: "第一层", onClose: () => setFirst(false), layerClassName: "", panelClassName: "" },
        createElement("button", { type: "button" }, "一"),
      ),
    second &&
      createElement(
        Modal,
        { title: "第二层", onClose: () => setSecond(false), layerClassName: "", panelClassName: "" },
        createElement("button", { type: "button" }, "二"),
      ),
  );
}

describe("桌面 Modal", () => {
  it("Esc 只关闭顶层，全部关闭后恢复背景与触发点", async () => {
    await act(async () => root!.render(createElement(StackExample)));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    expect(appRoot.inert).toBe(true);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(appRoot.inert).toBe(true);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    expect(appRoot.inert).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("Tab 在首个与末尾控件之间循环", async () => {
    await act(async () =>
      root!.render(
        createElement(
          Modal,
          { title: "焦点", layerClassName: "", panelClassName: "" },
          createElement("button", { type: "button", "data-testid": "first" }, "首"),
          createElement("button", { type: "button", "data-testid": "last" }, "尾"),
        ),
      ),
    );
    const first = document.querySelector<HTMLButtonElement>('[data-testid="first"]')!;
    const last = document.querySelector<HTMLButtonElement>('[data-testid="last"]')!;
    await act(async () => last.focus());
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(first);
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(last);
  });
});
