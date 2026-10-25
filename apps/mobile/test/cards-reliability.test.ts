/** @vitest-environment jsdom */
import type { PermissionRequest, QuestionRequest } from "@spcode/shared";
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionCard } from "../src/components/PermissionCard";
import { QuestionCard } from "../src/components/QuestionCard";
import { useAppStore } from "../src/state/store";

const mocks = vi.hoisted(() => ({ replyPermission: vi.fn(), replyQuestion: vi.fn() }));
vi.mock("../src/state/controller", () => ({
  replyPermission: mocks.replyPermission,
  replyQuestion: mocks.replyQuestion,
}));

let container: HTMLDivElement;
let root: Root | null;

const permission: PermissionRequest = {
  requestId: "p1",
  sessionId: "s1",
  toolName: "bash",
  args: { command: "echo 完整参数", risk: "write" },
  risk: "write",
};
const danger: PermissionRequest = {
  ...permission,
  requestId: "danger-1",
  risk: "danger",
  args: { command: "danger --full-arguments", lines: Array.from({ length: 30 }, (_, i) => `line-${i}`) },
};
const question: QuestionRequest = {
  requestId: "q1",
  sessionId: "s1",
  questions: [
    {
      question: "请选择",
      options: [{ value: "a", label: "选项 A" }],
    },
  ],
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function render(element: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => root!.render(createElement(I18nextProvider, { i18n }, element)));
}

function pointer(target: HTMLElement, type: string, pointerId: number): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: "touch" },
    button: { value: 0 },
  });
  target.dispatchEvent(event);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  useAppStore.getState().reset();
  mocks.replyPermission.mockReset();
  mocks.replyQuestion.mockReset();
  container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("权限回复与危险确认", () => {
  it("提交中禁用操作；失败保留卡片并可手动重试，不自动重发", async () => {
    const pending = deferred();
    mocks.replyPermission.mockReturnValueOnce(pending.promise);
    await render(createElement(PermissionCard, { request: permission }));
    const allow = document.querySelector<HTMLButtonElement>('[data-testid="permission-allow"]')!;
    await act(async () => allow.click());
    expect(allow.disabled).toBe(true);
    expect(allow.textContent).toContain("提交中");
    expect(mocks.replyPermission).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.reject(new Error("结果未知"));
      await Promise.resolve();
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("结果未知");
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(allow.disabled).toBe(false);
    await act(async () => Promise.resolve());
    expect(mocks.replyPermission).toHaveBeenCalledTimes(1);

    mocks.replyPermission.mockResolvedValueOnce(undefined);
    await act(async () => allow.click());
    expect(mocks.replyPermission).toHaveBeenCalledTimes(2);
  });

  it("danger 长按绑定单一 pointerId，其他手指的取消不影响当前指针", async () => {
    vi.useFakeTimers();
    mocks.replyPermission.mockResolvedValue(undefined);
    await render(createElement(PermissionCard, { request: danger }));
    const hold = document.querySelector<HTMLElement>('[data-testid="danger-hold"]')!;
    await act(async () => pointer(hold, "pointerdown", 1));
    await act(async () => pointer(hold, "pointerdown", 2));
    await act(async () => vi.advanceTimersByTime(500));
    await act(async () => pointer(hold, "pointercancel", 2));
    await act(async () => vi.advanceTimersByTime(1100));
    expect(mocks.replyPermission).toHaveBeenCalledTimes(1);
    expect(mocks.replyPermission).toHaveBeenCalledWith("danger-1", true);
  });

  it("pointercancel/lost capture 会取消；卸载后迟到计时器不提交", async () => {
    vi.useFakeTimers();
    mocks.replyPermission.mockResolvedValue(undefined);
    await render(createElement(PermissionCard, { request: danger }));
    const hold = document.querySelector<HTMLElement>('[data-testid="danger-hold"]')!;
    await act(async () => pointer(hold, "pointerdown", 7));
    await act(async () => vi.advanceTimersByTime(300));
    await act(async () => pointer(hold, "pointercancel", 7));
    await act(async () => pointer(hold, "pointerdown", 8));
    await act(async () => vi.advanceTimersByTime(300));
    await act(async () => pointer(hold, "lostpointercapture", 8));
    await act(async () => vi.advanceTimersByTime(1800));
    expect(mocks.replyPermission).not.toHaveBeenCalled();

    await act(async () => pointer(hold, "pointerdown", 9));
    await act(async () => root!.unmount());
    root = null;
    await act(async () => vi.advanceTimersByTime(1800));
    expect(mocks.replyPermission).not.toHaveBeenCalled();
  });

  it("完整参数可滚动查看，并提供无需长按的两步确认", async () => {
    mocks.replyPermission.mockResolvedValue(undefined);
    await render(createElement(PermissionCard, { request: danger }));
    const args = document.querySelector<HTMLElement>('section[aria-label="完整工具参数"]')!;
    expect(args.textContent).toContain("danger --full-arguments");
    expect(args.textContent).toContain("line-29");
    expect(args.className).toContain("overflow-auto");

    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="danger-reviewed"]')!.click());
    expect(mocks.replyPermission).not.toHaveBeenCalled();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="danger-confirm"]')!.click());
    expect(mocks.replyPermission).toHaveBeenCalledWith("danger-1", true);
  });
});

describe("提问草稿与回复", () => {
  it("权限遮挡导致卸载后按 requestId 恢复草稿；失败保留答案并可重试", async () => {
    await render(createElement(QuestionCard, { request: question }));
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="question-option-0-0"]')!.click());
    const setFreeText = (value: string) => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="question-free-text-0"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => setFreeText("不能丢失的答案"));

    // App 在权限插入时会卸载 QuestionCard；重新挂载必须恢复同一 requestId 的草稿。
    await act(async () => root!.unmount());
    root = createRoot(container);
    await render(createElement(QuestionCard, { request: question }));
    expect(document.querySelector<HTMLInputElement>('[data-testid="question-free-text-0"]')!.value).toBe(
      "不能丢失的答案",
    );
    expect(document.querySelector('[data-testid="question-option-0-0"]')?.getAttribute("aria-pressed")).toBe("true");

    const pending = deferred();
    mocks.replyQuestion.mockReturnValueOnce(pending.promise);
    const submit = document.querySelector<HTMLButtonElement>('[data-testid="question-submit"]')!;
    await act(async () => submit.click());
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain("提交中");
    await act(async () => {
      pending.reject(new Error("提问结果未知"));
      await Promise.resolve();
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("提问结果未知");
    expect(document.querySelector<HTMLInputElement>('[data-testid="question-free-text-0"]')!.value).toBe(
      "不能丢失的答案",
    );
    expect(mocks.replyQuestion).toHaveBeenCalledTimes(1);

    mocks.replyQuestion.mockResolvedValueOnce(undefined);
    await act(async () => submit.click());
    expect(mocks.replyQuestion).toHaveBeenCalledTimes(2);
  });
});
