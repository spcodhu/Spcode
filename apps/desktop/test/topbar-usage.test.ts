/** @vitest-environment jsdom */
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopBar } from "../src/renderer/src/components/TopBar.js";
import { type SessionState, useStore } from "../src/renderer/src/store.js";

let root: Root;
let container: HTMLDivElement;

function session(usage: Partial<SessionState["usage"]> = {}): SessionState {
  return {
    meta: {
      id: "s1",
      mode: "chat",
      cwd: "",
      title: "用量测试",
      model: null,
      thinkingLevel: "off",
      createdAt: 0,
      updatedAt: 0,
    },
    messages: [],
    running: false,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costInput: 0,
      costOutput: 0,
      costCacheRead: 0,
      costCacheWrite: 0,
      costTotal: 0,
      count: 0,
      unpricedCount: 0,
      ...usage,
    },
    usageLoaded: true,
    lastUsage: null,
    supportedThinkingLevels: [],
    todos: [],
    planMode: false,
    permissionMode: "ask",
  };
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useStore.setState({ activeSessionId: "s1", sessions: { s1: session() } });
  await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(TopBar))));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useStore.setState({ activeSessionId: null, sessions: {} });
  vi.unstubAllGlobals();
});

describe("TopBar 会话用量", () => {
  it("零用量也始终显示 chip", () => {
    expect(container.textContent).toContain("缓存 0%");
    expect(container.textContent).toContain("$0.0000");
  });

  it("token 总量包含输入、输出、缓存读与缓存写，成本保持单行", async () => {
    await act(async () => {
      useStore.setState({
        sessions: {
          s1: session({
            input: 1_000_000,
            output: 200_000,
            cacheRead: 300_000,
            cacheWrite: 50_000,
            costTotal: 1.25,
            count: 3,
          }),
        },
      });
    });
    const chip = container.querySelector(".whitespace-nowrap");
    expect(chip?.textContent).toContain("1.6M");
    expect(chip?.textContent).toContain("$1.2500");
  });

  it("存在未定价记录时显示成本不完整，而不是伪造 $0", async () => {
    await act(async () => {
      useStore.setState({ sessions: { s1: session({ unpricedCount: 1, count: 1 }) } });
    });
    expect(container.textContent).toContain("$—");
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain("含未定价调用");
  });
});
