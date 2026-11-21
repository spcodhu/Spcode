/** @vitest-environment jsdom */
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePanel, WorkspacePanelFrame } from "../src/renderer/src/components/WorkspacePanel.js";
import { type ChatMessage, useStore } from "../src/renderer/src/store.js";
import { workspaceDeliverables } from "../src/renderer/src/workspace-deliverables.js";

function assistant(text: string): ChatMessage {
  return { id: text, role: "assistant", segments: [{ kind: "text", id: `${text}-seg`, text }], streaming: false };
}

describe("工作区会话文件列表", () => {
  it("只收助手正文明确分享的本地文件，按路径去重", () => {
    const messages: ChatMessage[] = [
      {
        id: "user",
        role: "user",
        segments: [{ kind: "text", id: "u", text: "请看 [用户文件](user.txt)" }],
        streaming: false,
      },
      {
        id: "tools",
        role: "assistant",
        segments: [
          {
            kind: "tools",
            id: "t",
            calls: [
              {
                id: "write-1",
                name: "write",
                args: { path: "internal.ts" },
                status: "done",
                output: "Successfully wrote to internal.ts",
              },
            ],
          },
        ],
        streaming: false,
      },
      assistant("已生成 [报告](docs/report.md)，源文件见 [报告](docs/report.md) 和 [计划](plan:/tmp/PLAN.md)。"),
      assistant("![插图](images/a.png) [网页](https://example.com/a.md) `[代码示例](example.ts)`"),
    ];
    expect(workspaceDeliverables(messages)).toEqual([
      { path: "docs/report.md", label: "报告", kind: "file" },
      { path: "/tmp/PLAN.md", label: "计划", kind: "plan" },
    ]);
  });

  it("没有明确文件链接时返回空列表", () => {
    expect(workspaceDeliverables([assistant("只说明过程，没有交付文件。")])).toEqual([]);
  });
});

describe("工作区面板收起按钮", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    setLocale("zh-CN");
    useStore.setState(useStore.getInitialState(), true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useStore.setState(useStore.getInitialState(), true);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("图标是真实可访问的非拖拽按钮，收起与原 X 按钮均可关闭面板", async () => {
    const sessionId = await useStore.getState().createSession("chat");
    useStore.getState().toggleWorkspacePanel();
    await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(WorkspacePanel))));
    const collapse = container.querySelector<HTMLButtonElement>('[data-testid="workspace-panel-collapse"]')!;
    expect(collapse.tagName).toBe("BUTTON");
    expect(collapse.type).toBe("button");
    expect(collapse.title).toBe(i18n.t("chat:workspace.close"));
    expect(collapse.getAttribute("aria-label")).toBe(collapse.title);
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    expect([...collapse.classList]).toEqual(
      expect.arrayContaining([
        "titlebar-no-drag",
        "flex",
        "h-7",
        "w-7",
        "shrink-0",
        "items-center",
        "justify-center",
        "transition-colors",
        "hover:bg-bg-hover",
      ]),
    );
    expect(collapse.closest("header")?.classList.contains("titlebar-drag")).toBe(true);
    await act(async () => collapse.click());
    expect(container.querySelector('[data-testid="workspace-panel"]')).toBeNull();
    expect(useStore.getState().workspacePanels[sessionId]?.dismissed).toBe(true);

    await act(async () => useStore.getState().toggleWorkspacePanel());
    const close = container.querySelector<HTMLButtonElement>('[data-testid="workspace-panel-close"]')!;
    await act(async () => close.click());
    expect(container.querySelector('[data-testid="workspace-panel"]')).toBeNull();
    expect(useStore.getState().workspacePanels[sessionId]?.dismissed).toBe(true);
  });

  it("第三屏开合有过渡，快速重开取消卸载，稳定后拖宽不受 transition 拖慢", async () => {
    await useStore.getState().createSession("chat");
    useStore.getState().toggleWorkspacePanel();
    await act(async () =>
      root.render(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(WorkspacePanelFrame, {
            width: 480,
            min: 320,
            max: 760,
            onChange: vi.fn(),
            onReset: vi.fn(),
          }),
        ),
      ),
    );
    const frame = container.querySelector<HTMLElement>('[data-testid="workspace-panel-frame"]')!;
    expect(frame.style.width).toBe("488px");
    expect(frame.dataset.open).toBe("true");
    expect(frame.className).toContain("transition-[width]");

    await act(async () => vi.advanceTimersByTime(300));
    expect(frame.className).not.toContain("transition-[width]");

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="workspace-panel-close"]')!.click());
    expect(frame.isConnected).toBe(true);
    expect(frame.style.width).toBe("0px");
    expect(frame.dataset.open).toBe("false");
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.hasAttribute("inert")).toBe(true);

    await act(async () => useStore.getState().toggleWorkspacePanel());
    await act(async () => vi.advanceTimersByTime(300));
    expect(frame.isConnected).toBe(true);
    expect(frame.style.width).toBe("488px");
    expect(frame.dataset.open).toBe("true");

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="workspace-panel-close"]')!.click());
    await act(async () => vi.advanceTimersByTime(299));
    expect(frame.isConnected).toBe(true);
    await act(async () => vi.advanceTimersByTime(1));
    expect(container.querySelector('[data-testid="workspace-panel-frame"]')).toBeNull();
  });
});
