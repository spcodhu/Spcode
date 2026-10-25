/** @vitest-environment jsdom */
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchPalette } from "../src/renderer/src/components/SearchPalette.js";

const store = vi.hoisted(() => ({
  registrySessions: [] as any[],
  sessions: {} as Record<string, unknown>,
  setActive: vi.fn(),
  openSession: vi.fn(),
}));
vi.mock("../src/renderer/src/store", () => ({
  useStore: (selector: (state: typeof store) => unknown) => selector(store),
}));

function session(id: string, title: string) {
  return {
    id,
    mode: "chat",
    cwd: "",
    title,
    model: null,
    thinkingLevel: "medium",
    sessionFile: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function result(id: string) {
  return { id, titleMatch: true, hits: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let root: Root;
const container = document;
let mount: HTMLDivElement;
let onClose: ReturnType<typeof vi.fn>;
let searchSessions: ReturnType<typeof vi.fn>;
let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  store.registrySessions = [session("a", "Alpha"), session("b", "Beta")];
  store.sessions = {};
  store.setActive.mockReset();
  store.openSession.mockReset();
  onClose = vi.fn();
  searchSessions = vi.fn();
  scrollIntoView = vi.fn();
  Object.defineProperty(window, "spcode", { configurable: true, value: { searchSessions } });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
  mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
});

afterEach(async () => {
  await act(async () => root.unmount());
  mount.remove();
  Reflect.deleteProperty(window, "spcode");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setLocale("zh-CN");
});

async function render() {
  await act(async () =>
    root.render(createElement(I18nextProvider, { i18n }, createElement(SearchPalette, { onClose }))),
  );
}

function input(): HTMLInputElement {
  return container.querySelector('[data-testid="session-search-input"]')!;
}

async function typeQuery(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function startSearch() {
  await act(async () => {
    vi.advanceTimersByTime(200);
  });
}

async function key(key: string, isComposing = false) {
  await act(async () => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    Object.defineProperty(event, "isComposing", { value: isComposing });
    input().dispatchEvent(event);
  });
}

function options(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
}

describe("会话搜索弹窗", () => {
  it("忽略乱序响应，并在清空查询后作废未完成的请求", async () => {
    const oldRequest = deferred<any>();
    const newRequest = deferred<any>();
    const pendingRequest = deferred<any>();
    searchSessions.mockImplementation((query: string) => {
      if (query === "old") return oldRequest.promise;
      if (query === "new") return newRequest.promise;
      return pendingRequest.promise;
    });
    await render();

    await typeQuery("old");
    await startSearch();
    await typeQuery("new");
    await startSearch();
    await act(async () => newRequest.resolve([result("b")]));
    expect(options()).toHaveLength(1);
    expect(options()[0]!.textContent).toContain("Beta");

    await act(async () => oldRequest.resolve([result("a")]));
    expect(options()).toHaveLength(1);
    expect(options()[0]!.textContent).toContain("Beta");

    await typeQuery("pending");
    await startSearch();
    await typeQuery("");
    await act(async () => pendingRequest.resolve([result("a")]));
    expect(options()).toHaveLength(0);
    expect(container.querySelector('[data-testid="session-search-empty"]')).toBeNull();
    expect(container.querySelector('[data-testid="session-search-error"]')).toBeNull();
  });

  it("把搜索失败显示为错误态，而不是无结果，并可在后续查询恢复", async () => {
    const request = deferred<any>();
    searchSessions.mockReturnValueOnce(request.promise).mockResolvedValue([]);
    await render();
    expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe("true");

    await typeQuery("broken");
    await startSearch();
    await act(async () => request.reject(new Error("搜索服务断开")));
    expect(container.querySelector('[data-testid="session-search-error"]')?.textContent).toContain("搜索服务断开");
    expect(container.querySelector('[data-testid="session-search-empty"]')).toBeNull();

    await typeQuery("ok");
    await startSearch();
    expect(container.querySelector('[data-testid="session-search-error"]')).toBeNull();
    expect(container.querySelector('[data-testid="session-search-empty"]')).not.toBeNull();
  });

  it("空结果按 ArrowDown 不产生负选中项，结果到达后选中并滚动到有效项", async () => {
    const request = deferred<any>();
    searchSessions.mockReturnValue(request.promise);
    await render();
    await typeQuery("two");
    await startSearch();

    await key("ArrowDown");
    await act(async () => request.resolve([result("a"), result("b")]));
    expect(options()).toHaveLength(2);
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
    expect(input().getAttribute("aria-activedescendant")).toBe("session-search-option-0");

    await key("ArrowDown");
    expect(options()[1].getAttribute("aria-selected")).toBe("true");
    expect(input().getAttribute("aria-activedescendant")).toBe("session-search-option-1");
    await key("ArrowDown");
    expect(options()[1].getAttribute("aria-selected")).toBe("true");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("IME 组合期间不处理 Enter/Escape，普通按键仍可打开或关闭", async () => {
    searchSessions.mockResolvedValue([result("a")]);
    await render();
    await typeQuery("alpha");
    await startSearch();

    await key("Enter", true);
    await key("Escape", true);
    expect(store.openSession).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    await key("Enter");
    expect(store.openSession).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
