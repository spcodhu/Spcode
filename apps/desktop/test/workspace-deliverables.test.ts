/** @vitest-environment jsdom */
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePanel } from "../src/renderer/src/components/WorkspacePanel.js";
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
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
});
