/** @vitest-environment jsdom */
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRunItem, MessageItem } from "../src/renderer/src/components/MessageItem.js";
import type { ChatMessage } from "../src/renderer/src/store.js";

let root: Root;
let container: HTMLDivElement;
let writeText: ReturnType<typeof vi.fn>;
const timestamp = new Date(2026, 10, 1, 22, 18).getTime();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("消息悬浮时间、复制与编辑", () => {
  it("用户消息显示精确时间，复制正文，编辑只预填原文与图片", async () => {
    const images = [{ name: "one.png", mimeType: "image/png", data: "one" }];
    const message: ChatMessage = {
      id: "u1",
      role: "user",
      timestamp,
      segments: [{ kind: "text", id: "text", text: "原始问题" }],
      images,
      streaming: false,
    };
    const prefill = vi.fn();
    window.addEventListener("spcode:composer-prefill", prefill);
    await act(async () =>
      root.render(createElement(I18nextProvider, { i18n }, createElement(MessageItem, { message }))),
    );

    expect(document.querySelector('[data-testid="message-time"]')?.textContent).toBe("2026-11-01 22:18");
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="message-copy"]')!.click());
    expect(writeText).toHaveBeenCalledWith("原始问题");
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="message-edit"]')!.click());

    expect(prefill).toHaveBeenCalledTimes(1);
    const event = prefill.mock.calls[0]![0] as CustomEvent<{ text: string; attachments: typeof images }>;
    expect(event.detail.text).toBe("原始问题");
    expect(event.detail.attachments).toEqual(images);
    expect(document.querySelectorAll('[data-testid="message-edit"]')).toHaveLength(1);
    window.removeEventListener("spcode:composer-prefill", prefill);
  });

  it("助手复制可见正文，不夹带思考、工具名称或工具输出", async () => {
    const messages: ChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        timestamp,
        segments: [
          { kind: "thinking", id: "think", text: "隐藏思考", done: true },
          { kind: "text", id: "stage", text: "第一阶段" },
          {
            kind: "tools",
            id: "tools",
            calls: [{ id: "call", name: "bash", args: {}, status: "done", output: "工具输出" }],
          },
          { kind: "text", id: "summary", text: "最终回答" },
        ],
        streaming: false,
      },
    ];
    await act(async () =>
      root.render(
        createElement(I18nextProvider, { i18n }, createElement(AssistantRunItem, { messages, active: false })),
      ),
    );
    expect(document.querySelector('[data-testid="message-time"]')?.textContent).toBe("2026-11-01 22:18");
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="message-copy"]')!.click());
    expect(writeText).toHaveBeenCalledWith("第一阶段\n\n最终回答");
    expect(writeText.mock.calls[0]![0]).not.toContain("隐藏思考");
    expect(writeText.mock.calls[0]![0]).not.toContain("工具输出");
    expect(document.querySelector('[data-testid="message-edit"]')).toBeNull();
  });
});
