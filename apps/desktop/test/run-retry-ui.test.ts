/** @vitest-environment jsdom */
import type { ScheduledRunRetryInput } from "@spcode/shared";
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoticeItem } from "../src/renderer/src/components/MessageItem.js";
import { makeRunErrorNotice, type SessionState, useStore } from "../src/renderer/src/store.js";

let mount: HTMLDivElement;
let root: Root;
let schedule: ReturnType<typeof vi.fn>;
let cancel: ReturnType<typeof vi.fn>;

function session(error = makeRunErrorNotice("429 Too Many Requests", 3)): SessionState {
  return {
    meta: {
      id: "s1",
      mode: "chat",
      cwd: "",
      title: "测试",
      model: null,
      thinkingLevel: "medium",
      createdAt: 0,
      updatedAt: 0,
    },
    messages: [
      {
        id: "user-1",
        role: "user",
        segments: [{ kind: "text", id: "text-1", text: "继续生成报表" }],
        images: [{ name: "a.png", mimeType: "image/png", data: "aGVsbG8=" }],
        streaming: false,
      },
      error,
    ],
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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  schedule = vi.fn().mockImplementation(async (input: ScheduledRunRetryInput) => ({
    ...input,
    id: "retry-1",
    createdAt: Date.now(),
  }));
  cancel = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "spcode", {
    configurable: true,
    value: { runRetrySchedule: schedule, runRetryCancel: cancel },
  });
  useStore.setState({ sessions: { s1: session() }, runRetries: [] });
  mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
});

afterEach(async () => {
  await act(async () => root.unmount());
  mount.remove();
  useStore.setState({ sessions: {}, runRetries: [] });
  Reflect.deleteProperty(window, "spcode");
  vi.unstubAllGlobals();
});

async function render(errorId?: string) {
  const current = useStore.getState().sessions.s1!;
  const error = current.messages.find((message) => message.notice?.kind === "runError" && message.id === errorId) ??
    current.messages.find((message) => message.notice?.kind === "runError")!;
  await act(async () =>
    root.render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(NoticeItem, { message: error, sessionId: "s1" }),
      ),
    ),
  );
}

async function click(testId: string) {
  await act(async () => document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click());
}

describe("错误卡定时重试", () => {
  it("三小时后重试携带原指令和图片，可取消已安排重试", async () => {
    await render();
    await click("run-retry-toggle");
    expect(document.querySelector('[data-testid="run-retry-panel"]')).not.toBeNull();
    const before = Date.now();
    await click("run-retry-3h");
    expect(schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        text: "继续生成报表",
        images: [{ name: "a.png", mimeType: "image/png", data: "aGVsbG8=" }],
      }),
    );
    const input = schedule.mock.calls[0]?.[0] as ScheduledRunRetryInput;
    expect(input.runAt).toBeGreaterThanOrEqual(before + 3 * 3_600_000);
    expect(document.querySelector('[data-testid="run-retry-scheduled"]')?.textContent).toContain("重新发送");
    await click("run-retry-cancel");
    expect(cancel).toHaveBeenCalledWith("retry-1");
    expect(document.querySelector('[data-testid="run-retry-toggle"]')).not.toBeNull();
  });

  it("过去时间显示错误，不调用调度接口", async () => {
    await render();
    await click("run-retry-toggle");
    const input = document.querySelector<HTMLInputElement>('[data-testid="run-retry-exact"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "2020-01-01T00:00");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("run-retry-exact-submit");
    expect(schedule).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="run-retry-error"]')?.textContent).toContain("未来");
  });

  it("已有后续活动的旧错误卡不提供重试", async () => {
    const current = session();
    current.messages.push({
      id: "later-user",
      role: "user",
      segments: [{ kind: "text", id: "later-text", text: "新任务" }],
      streaming: false,
    });
    useStore.setState({ sessions: { s1: current } });
    await render();
    expect(document.querySelector('[data-testid="run-retry-toggle"]')).toBeNull();
  });
});
