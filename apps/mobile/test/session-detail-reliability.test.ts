/** @vitest-environment jsdom */
import type { SessionMeta } from "@spcode/shared";
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDetailPage } from "../src/pages/SessionDetailPage";
import { useAppStore } from "../src/state/store";

const mocks = vi.hoisted(() => ({
  sendPrompt: vi.fn(),
  setSessionModel: vi.fn(),
  refreshModels: vi.fn(),
  abortSession: vi.fn(),
  ensureSessionOutput: vi.fn(),
  retrySessionOutput: vi.fn(),
}));
vi.mock("../src/state/controller", () => ({
  sendPrompt: mocks.sendPrompt,
  setSessionModel: mocks.setSessionModel,
  refreshModels: mocks.refreshModels,
  abortSession: mocks.abortSession,
  ensureSessionOutput: mocks.ensureSessionOutput,
  retrySessionOutput: mocks.retrySessionOutput,
}));

let container: HTMLDivElement;
let root: Root;

function session(id: string): SessionMeta {
  return {
    id,
    mode: "chat",
    cwd: "",
    title: id,
    model: null,
    thinkingLevel: "medium",
    sessionFile: null,
    createdAt: 1,
    updatedAt: 2,
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderPage(sessionId: string): Promise<void> {
  await act(async () =>
    root!.render(createElement(I18nextProvider, { i18n }, createElement(SessionDetailPage, { sessionId }))),
  );
}

function input(): HTMLTextAreaElement {
  return document.querySelector('[data-testid="session-input"]')!;
}

function setInput(value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value);
  input().dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  useAppStore.getState().reset();
  useAppStore.getState().setSessions([session("s1"), session("s2")]);
  useAppStore.getState().setConn("ready");
  mocks.sendPrompt.mockReset();
  mocks.setSessionModel.mockReset().mockResolvedValue(undefined);
  mocks.refreshModels.mockReset().mockResolvedValue([]);
  useAppStore.getState().setModels(
    [
      {
        provider: "p",
        modelId: "new",
        displayName: "New Model",
        contextWindow: 1000,
        maxTokens: 100,
        thinkingLevels: [],
        available: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        priceKnown: false,
      },
    ],
    null,
  );
  mocks.abortSession.mockReset();
  mocks.ensureSessionOutput.mockReset().mockResolvedValue(undefined);
  mocks.retrySessionOutput.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("会话输出加载状态", () => {
  it("加载完成前不显示暂无输出；失败提供 alert 与重试，chunk 容器不做 live 播报", async () => {
    await renderPage("s1");
    expect(document.querySelector('[role="status"]')?.textContent).toContain("正在加载会话输出");
    expect(document.body.textContent).not.toContain("暂无输出");

    await act(async () => useAppStore.getState().setOutputSync("s1", { status: "loaded" }));
    expect(document.body.textContent).toContain("暂无输出");

    await act(async () =>
      useAppStore.getState().setOutputSync("s1", { status: "error", error: new Error("补拉失败") }),
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("补拉失败");
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="output-retry"]')!.click());
    expect(mocks.retrySessionOutput).toHaveBeenCalledWith("s1");

    await act(async () => {
      useAppStore.getState().setOutputSync("s1", { status: "loaded" });
      useAppStore.getState().appendOutput("s1", "chunk", "text", 0);
    });
    const scroller = document.querySelector('[data-testid="session-output-scroller"]')!;
    expect(scroller.getAttribute("role")).toBeNull();
    expect(scroller.getAttribute("aria-live")).toBeNull();
    expect(document.querySelector('[role="status"]')).toBeNull();
  });
});

describe("共享 Markdown 渲染", () => {
  it("助手正文使用与桌面相同的 Streamdown，而不是纯 pre 原文", async () => {
    await renderPage("s1");
    await act(async () => {
      useAppStore.getState().setOutputSync("s1", { status: "loaded" });
      useAppStore
        .getState()
        .appendOutput(
          "s1",
          "# 标题\n\n**粗体** 与 [链接](https://example.com)\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst answer = 42;\n```",
          "text",
          0,
        );
    });

    const body = document.querySelector('[data-testid="markdown-body"]')!;
    expect(body).not.toBeNull();
    expect(body.querySelector("h1")?.textContent).toBe("标题");
    expect(body.querySelector('[data-streamdown="strong"]')?.textContent).toBe("粗体");
    expect(body.querySelector('[data-streamdown="link"]')).not.toBeNull();
    expect(body.querySelector("table")).not.toBeNull();
    await vi.waitFor(() => {
      expect(body.querySelector('[data-streamdown="strong"]')?.textContent).toBe("粗体");
      expect(body.querySelector('[data-streamdown="code-block"]')).not.toBeNull();
    });
    expect(body.textContent).toContain("const answer = 42;");
  });
});

describe("会话输入草稿与发送失败", () => {
  it("按 sessionId 切换保留草稿；等待期间继续编辑时失败不覆盖新文本", async () => {
    const pending = deferred();
    mocks.sendPrompt.mockReturnValueOnce(pending.promise);
    await renderPage("s1");
    await act(async () => setInput("发送前快照"));
    await renderPage("s2");
    expect(input().value).toBe("");
    await act(async () => setInput("第二会话草稿"));
    await renderPage("s1");
    expect(input().value).toBe("发送前快照");

    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="session-send"]')!.click());
    expect(input().value).toBe("");
    expect(mocks.sendPrompt).toHaveBeenCalledWith("s1", "发送前快照");
    await act(async () => setInput("等待期间的新文本"));
    await act(async () => {
      pending.reject(new Error("发送失败"));
      await Promise.resolve();
    });
    expect(input().value).toBe("等待期间的新文本");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("发送失败");
    expect(useAppStore.getState().inputDrafts.s2?.text).toBe("第二会话草稿");
  });

  it("未继续编辑才恢复快照；旧会话请求失败不污染当前会话", async () => {
    const pending = deferred();
    mocks.sendPrompt.mockReturnValueOnce(pending.promise);
    await renderPage("s1");
    await act(async () => setInput("需要恢复的快照"));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="session-send"]')!.click());
    await renderPage("s2");
    await act(async () => setInput("当前会话新文本"));

    await act(async () => {
      pending.reject(new Error("旧请求失败"));
      await Promise.resolve();
    });
    expect(input().value).toBe("当前会话新文本");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(useAppStore.getState().inputDrafts.s1?.text).toBe("需要恢复的快照");
    await renderPage("s1");
    expect(input().value).toBe("需要恢复的快照");
  });
});

describe("已有会话模型切换", () => {
  it("从 PC 模型目录选择后调用 setSessionModel", async () => {
    await renderPage("s1");
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="model-field"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-model="p/new"]')!.click());
    expect(mocks.setSessionModel).toHaveBeenCalledWith("s1", { provider: "p", modelId: "new" });
  });
});
