import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../src/renderer/src/store.js";

function seed(planMode: boolean) {
  useStore.setState({
    activeSessionId: "s-plan",
    planPanel: { sessionId: "s-plan", path: "/tmp/plans/s-plan.md" },
    sessions: {
      "s-plan": {
        meta: {
          id: "s-plan",
          mode: "chat",
          cwd: "",
          title: "Plan",
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
        planMode,
        permissionMode: "ask",
        draft: true,
      },
    },
  });
}

beforeEach(() => {
  vi.stubGlobal("window", { spcode: {} });
});

describe("开始执行 Plan", () => {
  it("先关闭计划模式，再发送包含文件路径与 TodoWrite 约定的执行指令", async () => {
    seed(true);
    const sendPrompt = vi.fn(async () => true);
    useStore.setState({ sendPrompt });
    const ok = await useStore.getState().startPlanExecution();
    expect(ok).toBe(true);
    expect(useStore.getState().sessions["s-plan"]?.planMode).toBe(false);
    expect(sendPrompt).toHaveBeenCalledOnce();
    const prompt = sendPrompt.mock.calls[0]![0] as string;
    expect(prompt).toContain("/tmp/plans/s-plan.md");
    expect(prompt).toContain("TodoWrite");
  });

  it("关闭计划模式失败时绝不发送执行指令", async () => {
    seed(true);
    const setPlanMode = vi.fn(async () => {});
    const sendPrompt = vi.fn(async () => true);
    useStore.setState({ setPlanMode, sendPrompt });
    const ok = await useStore.getState().startPlanExecution();
    expect(ok).toBe(false);
    expect(setPlanMode).toHaveBeenCalledWith(false);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("非计划态或缺少文件时不启动", async () => {
    seed(false);
    const sendPrompt = vi.fn(async () => true);
    useStore.setState({ sendPrompt });
    expect(await useStore.getState().startPlanExecution()).toBe(false);
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});
