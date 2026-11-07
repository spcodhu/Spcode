/** @vitest-environment jsdom */
import type { ScheduleTask } from "@spcode/shared";
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleEditorSheet } from "../src/components/ScheduleEditor.js";
import { useAppStore } from "../src/state/store";

const state = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), refreshModels: vi.fn() }));
vi.mock("../src/state/controller", () => ({
  createSchedule: state.create,
  updateSchedule: state.update,
  refreshModels: state.refreshModels,
}));

let appRoot: HTMLDivElement;
let root: Root;
let onClose: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  state.create.mockReset().mockResolvedValue(undefined);
  state.update.mockReset().mockResolvedValue(undefined);
  state.refreshModels.mockReset().mockResolvedValue([]);
  useAppStore.getState().reset();
  useAppStore.getState().setConn("ready");
  useAppStore.getState().setModels(
    [
      {
        provider: "p",
        modelId: "scheduled",
        displayName: "Scheduled Model",
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
  appRoot = document.createElement("div");
  appRoot.id = "root";
  document.body.append(appRoot);
  root = createRoot(appRoot);
  onClose = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  appRoot.remove();
  vi.unstubAllGlobals();
});

function task(frequency: "once" | "daily"): ScheduleTask {
  return {
    id: "task-1",
    name: "旧名称",
    prompt: "执行内容",
    target: { kind: "chat" },
    frequency,
    hour: 9,
    minute: 0,
    runAt: frequency === "once" ? Date.now() - 86_400_000 : undefined,
    enabled: true,
    createdAt: 0,
  };
}

async function render(value: ScheduleTask) {
  await act(async () =>
    root.render(createElement(I18nextProvider, { i18n }, createElement(ScheduleEditorSheet, { task: value, onClose }))),
  );
}

function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("移动端定时任务编辑器", () => {
  it("过期单次任务只改名称仍保留原 runAt", async () => {
    const value = task("once");
    await render(value);
    const name = document.querySelector("input")!;
    await act(async () => setInput(name, "只改名称"));
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="schedule-submit"]')!.click();
      await Promise.resolve();
    });
    expect(state.update).toHaveBeenCalledWith(
      value.id,
      expect.objectContaining({ name: "只改名称", runAt: value.runAt }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("清空每日时间显示字段错误，不静默改成 00:00 或提交", async () => {
    await render(task("daily"));
    const time = document.querySelector<HTMLInputElement>('input[type="time"]')!;
    await act(async () => setInput(time, ""));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="schedule-submit"]')!.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("请选择有效的执行时间");
    expect(state.update).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("定时任务可选择 PC 模型，也可保持跟随默认", async () => {
    const value = task("daily");
    await render(value);
    expect(document.querySelector('[data-testid="model-option-default"]')).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="model-field"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-model="p/scheduled"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="schedule-submit"]')!.click());
    expect(state.update).toHaveBeenCalledWith(
      value.id,
      expect.objectContaining({ model: { provider: "p", modelId: "scheduled" } }),
    );
  });

  it("项目目标从 PC 已有空间选择，不再要求手输目录", async () => {
    useAppStore.getState().setSessions([
      {
        id: "project-1",
        mode: "project",
        cwd: "/code/demo",
        title: "demo",
        model: null,
        thinkingLevel: "medium",
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    const value = task("daily");
    await render(value);
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "项目会话")!
        .click();
    });
    expect(document.querySelector('input[aria-label*="项目目录"]')).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-cwd="/code/demo"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="schedule-submit"]')!.click());
    expect(state.update).toHaveBeenCalledWith(
      value.id,
      expect.objectContaining({ target: { kind: "project", cwd: "/code/demo" } }),
    );
  });

  it("已有会话目标可编辑保留，不被静默改成新聊天", async () => {
    useAppStore.getState().setSessions([
      {
        id: "existing",
        mode: "project",
        cwd: "/code/demo",
        title: "已有会话",
        model: null,
        thinkingLevel: "medium",
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    const value = { ...task("daily"), target: { kind: "session" as const, sessionId: "existing" } };
    await render(value);
    expect(document.querySelector<HTMLSelectElement>('select[aria-label="已有会话"]')?.value).toBe("existing");
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="schedule-submit"]')!.click());
    expect(state.update).toHaveBeenCalledWith(
      value.id,
      expect.objectContaining({ target: { kind: "session", sessionId: "existing" } }),
    );
  });
});
