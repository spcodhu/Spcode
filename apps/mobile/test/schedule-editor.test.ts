/** @vitest-environment jsdom */
import type { ScheduleTask } from "@spcode/shared";
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleEditorSheet } from "../src/components/ScheduleEditor.js";

const state = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock("../src/state/controller", () => ({ createSchedule: state.create, updateSchedule: state.update }));

let appRoot: HTMLDivElement;
let root: Root;
let onClose: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  state.create.mockReset().mockResolvedValue(undefined);
  state.update.mockReset().mockResolvedValue(undefined);
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
});
