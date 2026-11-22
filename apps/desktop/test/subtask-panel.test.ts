/**
 * 子任务面板（第三屏）与 store 子任务切片：
 * - session.task 事件按 taskId 覆盖式 upsert，垃圾载荷被 wire 守卫丢弃
 * - 新用户 prompt（message_end role=user，空闲时发送）清空上一轮子任务快照；steering 插话（运行中发送）不清空
 * - workspacePanelVisible：运行中/排队中子任务自动可见，全部终态不再撑开，dismissed 优先
 * - WorkspacePanel 渲染：默认仅运行中/排队中芯片，点芯片展开完整列表（含终态摘要与嵌套层级）
 */
/** @vitest-environment jsdom */
import type { TaskActivity } from "@spcode/shared";
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, type ComponentProps, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePanel } from "../src/renderer/src/components/WorkspacePanel.js";
import { teardownHostEvents, useStore, workspacePanelVisible } from "../src/renderer/src/store.js";

type PanelProps = ComponentProps<typeof WorkspacePanel>;

let root: Root;
let mount: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
});

afterEach(async () => {
  await act(async () => root.unmount());
  mount.remove();
  vi.unstubAllGlobals();
  setLocale("zh-CN");
  teardownHostEvents();
});

const SESSION_ID = "subtask-panel-session";

function baseTask(overrides: Partial<TaskActivity> = {}): TaskActivity {
  return {
    schemaVersion: 1,
    taskId: "task-1",
    parentTaskId: null,
    sourceToolCallId: "call-1",
    description: "调研配置链路",
    role: "readonly",
    depth: 0,
    status: "running",
    startedAt: 1000,
    updatedAt: 2000,
    turns: 3,
    maxTurns: 64,
    usage: { input: 120, output: 80, cacheRead: 40, cacheWrite: 0, costTotal: 0.01 },
    ...overrides,
  };
}

function seedSession(tasks: TaskActivity[] = [], running = true) {
  useStore.setState((s) => ({
    activeSessionId: SESSION_ID,
    sessions: {
      ...s.sessions,
      [SESSION_ID]: {
        meta: {
          id: SESSION_ID,
          mode: "chat" as const,
          cwd: "",
          title: "子任务面板测试",
          model: null,
          thinkingLevel: "off",
          createdAt: 0,
          updatedAt: 0,
        },
        messages: [],
        running,
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
        supportedThinkingLevels: [],
        todos: [],
        tasks,
        planMode: false,
        permissionMode: "ask" as const,
      },
    },
  }));
}

async function renderPanel(props: Partial<PanelProps> = {}) {
  await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(WorkspacePanel, props))));
}

function element(id: string): HTMLElement {
  const found = mount.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`);
  expect(found).toHaveLength(1);
  return found[0]!;
}

function elements(id: string): HTMLElement[] {
  return Array.from(mount.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
}

async function click(target: HTMLElement) {
  await act(async () => target.click());
}

describe("store 子任务切片", () => {
  it("session.task 按 taskId 覆盖式 upsert，保持首次到达顺序", () => {
    seedSession();
    const store = useStore.getState();
    store.applyHostEvent({ type: "session.task", sessionId: SESSION_ID, task: baseTask() });
    store.applyHostEvent({
      type: "session.task",
      sessionId: SESSION_ID,
      task: baseTask({ taskId: "task-2", description: "第二路并行" }),
    });
    store.applyHostEvent({ type: "session.task", sessionId: SESSION_ID, task: baseTask({ turns: 9 }) });
    const tasks = useStore.getState().sessions[SESSION_ID]!.tasks;
    expect(tasks.map((t) => t.taskId)).toEqual(["task-1", "task-2"]);
    expect(tasks[0]!.turns).toBe(9);
    expect(tasks[0]!.description).toBe("调研配置链路");
  });

  it("垃圾载荷被 wire 守卫拒绝，不改现有状态", () => {
    seedSession([baseTask()]);
    useStore.getState().applyHostEvent({ type: "session.task", sessionId: SESSION_ID, task: "broken" });
    useStore.getState().applyHostEvent({
      type: "session.task",
      sessionId: SESSION_ID,
      task: { noTaskId: true } as never,
    });
    expect(useStore.getState().sessions[SESSION_ID]!.tasks).toHaveLength(1);
  });

  it("新用户 prompt（空闲时发送）清空上一轮快照（与宿主每轮重开任务树对齐）", () => {
    seedSession([baseTask(), baseTask({ taskId: "task-2" })], false);
    useStore.getState().applyHostEvent({
      type: "session.event",
      sessionId: SESSION_ID,
      event: {
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "新的问题" }] },
      },
    });
    expect(useStore.getState().sessions[SESSION_ID]!.tasks).toEqual([]);
  });

  it("steering 插话（运行中 user 消息）不清空本轮快照（宿主 session.steer 不重开任务树）", () => {
    seedSession([baseTask(), baseTask({ taskId: "task-2" })]);
    useStore.getState().applyHostEvent({
      type: "session.event",
      sessionId: SESSION_ID,
      event: {
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "插话：顺便看下 X" }] },
      },
    });
    expect(useStore.getState().sessions[SESSION_ID]!.tasks).toHaveLength(2);
  });
});

describe("workspacePanelVisible 子任务条件", () => {
  it("运行中/排队中子任务使面板可见；全部终态不撑开；dismissed 仍优先", () => {
    const session = (tasks: TaskActivity[]) =>
      ({ todos: [], planMode: false, tasks }) as Parameters<typeof workspacePanelVisible>[0];
    expect(workspacePanelVisible(session([baseTask({ status: "running" })]), undefined)).toBe(true);
    expect(workspacePanelVisible(session([baseTask({ status: "queued" })]), undefined)).toBe(true);
    expect(workspacePanelVisible(session([baseTask({ status: "completed" })]), undefined)).toBe(false);
    expect(workspacePanelVisible(session([baseTask({ status: "cancelled" })]), undefined)).toBe(false);
    expect(
      workspacePanelVisible(session([baseTask({ status: "running" })]), { dismissed: true, files: [], opened: true }),
    ).toBe(false);
  });
});

describe("WorkspacePanel 子任务面板", () => {
  it("无子任务时整个 section 不渲染", async () => {
    seedSession([]);
    await renderPanel({ forceVisible: true });
    expect(elements("workspace-subtask-section")).toHaveLength(0);
  });

  it("默认仅显示运行中/排队中芯片；点芯片展开完整列表（含终态与嵌套）", async () => {
    seedSession([
      baseTask({ status: "running", lastTool: "grep" }),
      baseTask({ taskId: "task-2", description: "排队中的第二路", status: "queued" }),
      baseTask({
        taskId: "task-3",
        description: "已完成的调研",
        status: "completed",
        endedAt: 3000,
        summary: "结论：配置链路正常",
      }),
      baseTask({
        taskId: "task-4",
        description: "嵌套子任务",
        status: "completed",
        depth: 1,
        parentTaskId: "task-3",
        endedAt: 3200,
      }),
    ]);
    await renderPanel({ forceVisible: true });

    // 收起态：只渲染 running + queued 两枚芯片
    const chips = elements("workspace-subtask-chip");
    expect(chips.map((c) => c.dataset.status)).toEqual(["running", "queued"]);
    expect(elements("workspace-subtask-row")).toHaveLength(0);
    expect(element("workspace-subtask-toggle").textContent).toContain("子任务");

    // 点芯片 → 展开：完整列表按到达顺序，含已完成与嵌套（data-depth 标注层级）
    await click(chips[0]!);
    const rows = elements("workspace-subtask-row");
    expect(rows.map((r) => r.dataset.status)).toEqual(["running", "queued", "completed", "completed"]);
    expect(rows[2]!.textContent).toContain("已完成的调研");
    expect(rows[2]!.textContent).toContain("结论：配置链路正常");
    expect(rows[3]!.dataset.depth).toBe("1");
    expect(elements("workspace-subtask-chip")).toHaveLength(0);

    // 再点头部 toggle 收起
    await click(element("workspace-subtask-toggle"));
    expect(elements("workspace-subtask-chip").map((c) => c.dataset.status)).toEqual(["running", "queued"]);
  });

  it("运行中芯片显示轮次进度，头部显示运行计数", async () => {
    seedSession([baseTask({ turns: 7, maxTurns: 64 })]);
    await renderPanel({ forceVisible: true });
    expect(element("workspace-subtask-chip").textContent).toContain("7/64");
    expect(element("workspace-subtask-toggle").textContent).toContain("1 个运行中");
  });
});
