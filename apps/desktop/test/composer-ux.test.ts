/** @vitest-environment jsdom */
import type { ImageAttachment, PermissionMode } from "@spcode/shared";
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer, prefillComposer } from "../src/renderer/src/components/Composer.js";
import { type SessionState, useStore } from "../src/renderer/src/store.js";

const OLD_IMAGE: ImageAttachment = { name: "old.png", mimeType: "image/png", data: "b2xk" };
const NEW_IMAGE: ImageAttachment = { name: "new.png", mimeType: "image/png", data: "bmV3" };

function makeSession(id: string): SessionState {
  return {
    meta: {
      id,
      mode: "chat",
      cwd: "",
      title: id,
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
    },
    lastUsage: null,
    supportedThinkingLevels: [],
    todos: [],
    planMode: false,
    permissionMode: "never",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;
let sendPrompt: ReturnType<typeof vi.fn>;
let setPermissionMode: ReturnType<typeof vi.fn>;
let rafId: number;
let rafCallbacks: Map<number, FrameRequestCallback>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rafId = 0;
  rafCallbacks = new Map();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = ++rafId;
    rafCallbacks.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => rafCallbacks.delete(id));
  setLocale("zh-CN");
  sendPrompt = vi.fn();
  setPermissionMode = vi.fn(async (mode: PermissionMode) => {
    const id = useStore.getState().activeSessionId;
    if (!id) return;
    useStore.setState((state) => {
      const session = state.sessions[id];
      if (!session) return state;
      return { sessions: { ...state.sessions, [id]: { ...session, permissionMode: mode } } };
    });
  });
  useStore.setState({
    ready: true,
    settings: null,
    models: [],
    sessions: { s1: makeSession("s1"), s2: makeSession("s2") },
    sessionOrder: ["s1", "s2"],
    activeSessionId: "s1",
    registrySessions: [],
    composerDrafts: {},
    sendPrompt,
    setPermissionMode,
    abort: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setThinkingLevel: vi.fn(async () => {}),
    setPlanMode: vi.fn(async () => {}),
    compactSession: vi.fn(async () => {}),
  });
  Object.defineProperty(window, "spcode", {
    configurable: true,
    value: {
      pickImages: vi.fn(async () => []),
      pickFiles: vi.fn(async () => []),
      setComposerDrafts: vi.fn(async () => {}),
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, "spcode");
  vi.unstubAllGlobals();
  setLocale("zh-CN");
});

async function render(sessionId = "s1") {
  await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(Composer, { sessionId }))));
}

async function flushAnimationFrames() {
  const callbacks = [...rafCallbacks.values()];
  rafCallbacks.clear();
  await act(async () => {
    for (const callback of callbacks) callback(0);
  });
}

function element<T extends HTMLElement = HTMLButtonElement>(testId: string): T {
  const found = container.querySelector<T>(`[data-testid="${testId}"]`);
  expect(found).not.toBeNull();
  return found!;
}

function input(): HTMLTextAreaElement {
  return element<HTMLTextAreaElement>("composer-input");
}

async function click(testId: string) {
  await act(async () => element(testId).click());
}

async function type(text: string) {
  const textarea = input();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function prefill(text: string) {
  await act(async () => {
    prefillComposer(text);
  });
  await flushAnimationFrames();
}

async function key(target: Element, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
  await act(async () => target.dispatchEvent(event));
  return event;
}

function seedDraft(text: string, inputMode: "plain" | "markdown" = "plain") {
  useStore.getState().setComposerDraft("s1", { text, inputMode });
}

describe("Composer 空态建议 prefill", () => {
  it("已有草稿用两个换行追加，并聚焦到末尾", async () => {
    seedDraft("已有草稿");
    await render();
    await prefill("建议内容");
    expect(input().value).toBe("已有草稿\n\n建议内容");
    expect(useStore.getState().composerDrafts.s1?.text).toBe("已有草稿\n\n建议内容");
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe("已有草稿\n\n建议内容".length);
    expect(input().selectionEnd).toBe("已有草稿\n\n建议内容".length);
  });

  it("空草稿直接填入，不添加前置换行", async () => {
    await render();
    await prefill("直接建议");
    expect(input().value).toBe("直接建议");
    expect(input().selectionStart).toBe("直接建议".length);
  });

  it("Markdown 草稿追加后同样聚焦并把选区放到文档末尾", async () => {
    seedDraft("已有 **Markdown**", "markdown");
    await render();
    await prefill("新的建议");
    const editor = element("md-editor");
    expect(useStore.getState().composerDrafts.s1?.text).toBe("已有 **Markdown**\n\n新的建议");
    expect(document.activeElement).toBe(editor);
    const end = document.createRange();
    end.selectNodeContents(editor);
    end.collapse(false);
    expect(window.getSelection()?.anchorNode).toBe(end.startContainer);
    expect(window.getSelection()?.anchorOffset).toBe(end.startOffset);
  });
});

describe("Composer 发送失败恢复", () => {
  it("发送后继续输入时，迟到失败不覆盖新草稿", async () => {
    const request = deferred<boolean>();
    sendPrompt.mockReturnValue(request.promise);
    seedDraft("旧草稿");
    await render();
    await click("composer-send");
    expect(useStore.getState().composerDrafts.s1).toBeUndefined();

    await type("发送后的新草稿");
    await act(async () => {
      request.resolve(false);
      await request.promise;
    });
    expect(input().value).toBe("发送后的新草稿");
    expect(useStore.getState().composerDrafts.s1?.text).toBe("发送后的新草稿");
  });

  it("发送后改附件时保留新附件，不回写旧快照", async () => {
    const request = deferred<boolean>();
    sendPrompt.mockReturnValue(request.promise);
    seedDraft("旧草稿");
    useStore.getState().setComposerDraft("s1", { attachments: [OLD_IMAGE] });
    await render();
    await click("composer-send");

    await act(async () => useStore.getState().setComposerDraft("s1", { attachments: [NEW_IMAGE] }));
    await act(async () => {
      request.resolve(false);
      await request.promise;
    });
    const draft = useStore.getState().composerDrafts.s1;
    expect(draft?.text).toBe("");
    expect(draft?.attachments).toEqual([NEW_IMAGE]);
  });

  it("没有新编辑时仍自动恢复完整快照", async () => {
    const request = deferred<boolean>();
    sendPrompt.mockReturnValue(request.promise);
    seedDraft("需要恢复的草稿");
    useStore.getState().setComposerDraft("s1", {
      attachments: [OLD_IMAGE],
      files: [{ name: "note.txt", size: 4, text: "note" }],
    });
    await render();
    await click("composer-send");
    await act(async () => {
      request.resolve(false);
      await request.promise;
    });
    const draft = useStore.getState().composerDrafts.s1;
    expect(draft?.text).toBe("需要恢复的草稿");
    expect(draft?.attachments).toEqual([OLD_IMAGE]);
    expect(draft?.files).toEqual([{ name: "note.txt", size: 4, text: "note" }]);
  });

  it("新编辑即使随后清空，也不会被旧快照复活", async () => {
    const request = deferred<boolean>();
    sendPrompt.mockReturnValue(request.promise);
    seedDraft("旧草稿");
    await render();
    await click("composer-send");
    await type("临时输入");
    await type("");
    await act(async () => {
      request.resolve(false);
      await request.promise;
    });
    expect(useStore.getState().composerDrafts.s1).toBeUndefined();
    expect(input().value).toBe("");
  });

  it("切会话后的迟到失败只恢复来源草稿，不覆盖当前会话", async () => {
    const request = deferred<boolean>();
    sendPrompt.mockReturnValue(request.promise);
    seedDraft("会话一的旧草稿");
    await render("s1");
    await click("composer-send");
    await render("s2");
    await type("会话二的新草稿");

    await act(async () => {
      request.resolve(false);
      await request.promise;
    });
    expect(useStore.getState().composerDrafts.s1?.text).toBe("会话一的旧草稿");
    expect(useStore.getState().composerDrafts.s2?.text).toBe("会话二的新草稿");
    expect(input().value).toBe("会话二的新草稿");
  });
});

describe("Composer 编辑区快捷键与 Markdown 工具状态", () => {
  it("Shift+Tab 只在文本编辑区切权限，忽略 IME，按钮保留标准导航", async () => {
    await render();
    const plainEvent = await key(input(), { key: "Tab", shiftKey: true });
    expect(plainEvent.defaultPrevented).toBe(true);
    expect(setPermissionMode).toHaveBeenLastCalledWith("ask");

    const modeButtonEvent = await key(element("md-mode-toggle"), { key: "Tab", shiftKey: true });
    expect(modeButtonEvent.defaultPrevented).toBe(false);
    expect(setPermissionMode).toHaveBeenCalledTimes(1);

    await click("md-mode-toggle");
    const editor = element("md-editor");
    const markdownEvent = await key(editor, { key: "Tab", shiftKey: true });
    expect(markdownEvent.defaultPrevented).toBe(true);
    expect(setPermissionMode).toHaveBeenLastCalledWith("auto");

    const toolbarEvent = await key(element("md-tool-bold"), { key: "Tab", shiftKey: true });
    expect(toolbarEvent.defaultPrevented).toBe(false);
    expect(setPermissionMode).toHaveBeenCalledTimes(2);
    const composingEvent = await key(editor, { key: "Tab", shiftKey: true, isComposing: true });
    expect(composingEvent.defaultPrevented).toBe(false);
    expect(setPermissionMode).toHaveBeenCalledTimes(2);
  });

  it("预览禁用编辑工具但保留图片入口，分屏和编辑态恢复", async () => {
    seedDraft("# 标题", "markdown");
    await render();
    await click("md-view-preview");
    const previewTools = [...container.querySelectorAll<HTMLButtonElement>('[data-testid^="md-tool-"]')];
    expect(previewTools.length).toBeGreaterThan(0);
    for (const tool of previewTools) {
      expect(tool.disabled).toBe(tool.dataset.testid !== "md-tool-image");
    }

    await click("md-view-split");
    for (const tool of container.querySelectorAll<HTMLButtonElement>('[data-testid^="md-tool-"]')) {
      expect(tool.disabled).toBe(false);
    }
    await click("md-view-preview");
    await click("md-view-edit");
    expect(element("md-tool-bold").disabled).toBe(false);
    expect(element("md-tool-image").disabled).toBe(false);
  });
});
