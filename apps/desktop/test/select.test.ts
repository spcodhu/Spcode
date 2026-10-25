/** @vitest-environment jsdom */
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Select, type SelectOption } from "../src/renderer/src/components/ui/Select.js";

const BASE_OPTIONS: SelectOption[] = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
];

let root: Root;
let container: HTMLDivElement;
let outside: HTMLDivElement;
let onChange: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  setLocale("zh-CN");
  onChange = vi.fn();
  container = document.createElement("div");
  outside = document.createElement("div");
  document.body.append(container, outside);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  outside.remove();
  vi.unstubAllGlobals();
  setLocale("zh-CN");
});

async function render(options: SelectOption[] = BASE_OPTIONS, value = "b") {
  await act(async () =>
    root.render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(Select, {
          value,
          options,
          onChange,
          className: "w-44",
          label: "选择模型",
          testId: "demo-select",
        }),
      ),
    ),
  );
}

function trigger(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-testid="demo-select"]')!;
}

function listbox(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="listbox"]');
}

function options(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
}

async function key(target: Element, key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => target.dispatchEvent(event));
  return event;
}

describe("Select listbox 与键盘交互", () => {
  it("保留 trigger 属性，打开定位选中项并提供选中/滚动语义", async () => {
    await render();
    expect(container.firstElementChild?.className).toContain("w-44");
    expect(trigger().getAttribute("aria-label")).toBe("选择模型");
    expect(trigger().getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    const controls = trigger().getAttribute("aria-controls");
    expect(controls).toBeTruthy();

    await key(trigger(), "ArrowDown");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(listbox()?.id).toBe(controls);
    expect(listbox()?.getAttribute("aria-label")).toBe("选择模型");
    expect(listbox()?.className).toContain("max-h-64");
    expect(listbox()?.className).toContain("overflow-y-auto");
    expect(document.activeElement).toBe(options()[1]);
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(options()[1]?.querySelector("svg")).not.toBeNull();
    expect(options()[1]?.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(options()[0]?.getAttribute("aria-selected")).toBe("false");
  });

  it("方向键/Home/End 导航，Enter/Space 选择后关闭并还焦", async () => {
    await render();
    await act(async () => trigger().click());
    await key(options()[1]!, "ArrowDown");
    expect(document.activeElement).toBe(options()[2]);
    await key(options()[2]!, "Home");
    expect(document.activeElement).toBe(options()[0]);
    await key(options()[0]!, "End");
    expect(document.activeElement).toBe(options()[2]);
    await key(options()[2]!, "ArrowDown");
    expect(document.activeElement).toBe(options()[0]);
    await key(options()[0]!, "ArrowUp");
    expect(document.activeElement).toBe(options()[2]);

    await key(options()[2]!, "Enter");
    expect(onChange).toHaveBeenLastCalledWith("c");
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(trigger());

    await key(trigger(), " ");
    expect(document.activeElement).toBe(options()[1]);
    await key(options()[1]!, "ArrowUp");
    await key(options()[0]!, " ");
    expect(onChange).toHaveBeenLastCalledWith("a");
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("Esc 只关闭自身并还焦，点击外部只关闭弹层", async () => {
    await render();
    await act(async () => trigger().click());
    const outerShortcut = vi.fn();
    document.addEventListener("keydown", outerShortcut);
    await key(document.activeElement!, "Escape");
    document.removeEventListener("keydown", outerShortcut);
    expect(outerShortcut).not.toHaveBeenCalled();
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(trigger());

    await act(async () => trigger().click());
    expect(listbox()).not.toBeNull();
    await act(async () => outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(listbox()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("options 变化保留活动项焦点，活动项消失时回退到有效项", async () => {
    await render();
    await act(async () => trigger().click());
    await key(options()[1]!, "ArrowDown");
    expect(document.activeElement).toBe(options()[2]);

    await render([{ value: "x", label: "Extra" }, ...BASE_OPTIONS]);
    expect(document.activeElement?.textContent).toBe("Gamma");
    expect(document.activeElement?.getAttribute("role")).toBe("option");

    await render(BASE_OPTIONS.slice(0, 2));
    expect(document.activeElement).toBe(options()[1]);
    expect(options()).toHaveLength(2);
  });
});
