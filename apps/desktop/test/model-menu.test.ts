/** @vitest-environment jsdom */
import type { ModelRef } from "@spcode/shared";
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelMenu, type ModelOption } from "../src/renderer/src/components/Composer.js";

const models: ModelOption[] = [
  { provider: "deepseek", modelId: "deepseek-flash", displayName: "DeepSeek Flash" },
  { provider: "deepseek", modelId: "deepseek-pro", displayName: "DeepSeek Pro" },
  { provider: "kimi-coding", modelId: "k3", displayName: "Kimi K3" },
];
const value: ModelRef = { provider: "deepseek", modelId: "deepseek-flash" };

let root: Root;
let container: HTMLDivElement;
let onChange: ReturnType<typeof vi.fn>;
let onThinkingChange: ReturnType<typeof vi.fn>;

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
  onThinkingChange = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(options: ModelOption[] = models) {
  await act(async () =>
    root.render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(ModelMenu, {
          models: options,
          value,
          thinkingLevel: "medium",
          thinkingLevels: ["low", "medium", "high"],
          onChange,
          onThinkingChange,
        }),
      ),
    ),
  );
}

function element<T extends HTMLElement = HTMLButtonElement>(testId: string): T {
  const found = container.querySelector<T>(`[data-testid="${testId}"]`);
  expect(found).not.toBeNull();
  return found!;
}

function options(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[data-testid="composer-model-option"]')];
}

async function openModels() {
  await act(async () => element("composer-model-menu").click());
  await act(async () => element("composer-open-models").click());
}

async function typeQuery(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(key: string) {
  await act(async () => {
    (document.activeElement ?? document).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

describe("模型菜单", () => {
  it("按供应商分组，只显示一次 provider，初始聚焦搜索框并把当前模型滚入视野", async () => {
    await render();
    await openModels();
    const groups = [...container.querySelectorAll('[data-testid="composer-model-provider"]')];
    expect(groups.map((el) => el.textContent)).toEqual(["deepseek", "kimi-coding"]);
    expect(options()).toHaveLength(3);
    const selected = options()[0]!;
    expect(selected.getAttribute("aria-selected")).toBe("true");
    expect(selected.className).toContain("bg-accent-soft");
    // 支持直接打字过滤（OpenRouter 几百个模型场景）：默认聚焦搜索框而非选项
    expect(document.activeElement).toBe(element("composer-model-search"));
    expect(selected.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("搜索框过滤模型，支持按名称/ID/供应商匹配，并在清空后恢复全量", async () => {
    await render();
    await openModels();
    const search = element<HTMLInputElement>("composer-model-search");
    await typeQuery(search, "pro");
    expect(options()).toHaveLength(1);
    expect(options()[0]!.textContent).toContain("DeepSeek Pro");

    await typeQuery(search, "kimi-coding");
    expect(options()).toHaveLength(1);
    expect(options()[0]!.textContent).toContain("Kimi K3");

    await typeQuery(search, "没有这个模型");
    expect(options()).toHaveLength(0);
    expect(element("composer-model-search-empty")).toBeTruthy();

    await typeQuery(search, "");
    expect(options()).toHaveLength(3);
  });

  it("方向键、Home/End、选择后焦点归还和两级 Esc 可用", async () => {
    await render();
    await openModels();
    // 初始焦点在搜索框；第一次 ArrowDown 先落到第一项
    await key("ArrowDown");
    expect(document.activeElement).toBe(options()[0]);
    await key("ArrowDown");
    expect(document.activeElement).toBe(options()[1]);
    await key("End");
    expect(document.activeElement).toBe(options()[2]);
    await key("Home");
    expect(document.activeElement).toBe(options()[0]);

    await act(async () => options()[1]!.click());
    expect(onChange).toHaveBeenCalledWith({ provider: "deepseek", modelId: "deepseek-pro" });
    expect(options()).toHaveLength(0);
    expect(document.activeElement).toBe(element("composer-model-menu"));

    await openModels();
    await key("Escape");
    expect(element("composer-open-models")).toBeTruthy();
    expect(options()).toHaveLength(0);
    await key("Escape");
    expect(container.querySelector("#composer-model-popup")).toBeNull();
    expect(document.activeElement).toBe(element("composer-model-menu"));
  });

  it("仅同名冲突时补真实模型 ID，不自动美化原始 ID", async () => {
    await render([
      { provider: "p", modelId: "raw-id", displayName: "raw-id" },
      { provider: "p", modelId: "same-v1", displayName: "Same" },
      { provider: "p", modelId: "same-v2", displayName: "Same" },
    ]);
    await openModels();
    expect(options()[0]!.textContent).toBe("raw-id");
    expect(options()[1]!.textContent).toBe("Samesame-v1");
    expect(options()[2]!.textContent).toBe("Samesame-v2");
  });
});
