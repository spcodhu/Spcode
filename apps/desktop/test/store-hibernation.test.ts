import { afterEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../src/renderer/src/store.js";

/**
 * 会话切换的宿主侧休眠/唤醒联动（渲染进程侧）：
 * 切走空闲会话发 session.hibernate、切回已休眠会话发 session.activate，
 * 运行中/无 sessionFile 的会话不参与休眠，命令失败回滚乐观标记。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("会话切换的宿主休眠/唤醒联动", () => {
  const USAGE_ZERO = {
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
  };

  /** 塞入一个带 sessionFile 的已唤醒会话（绕过 IPC），返回 sessionId */
  function seedAwakeSession(sessionId: string, opts?: { running?: boolean; draft?: boolean }) {
    useStore.setState((s) => ({
      activeSessionId: sessionId,
      sessions: {
        ...s.sessions,
        [sessionId]: {
          meta: {
            id: sessionId,
            mode: "chat" as const,
            cwd: "",
            title: "t",
            model: null,
            thinkingLevel: "off",
            createdAt: 0,
            updatedAt: 0,
          },
          messages: [],
          running: opts?.running ?? false,
          usage: { ...USAGE_ZERO },
          lastUsage: null,
          supportedThinkingLevels: [],
          todos: [],
          planMode: false,
          sessionFile: `/tmp/${sessionId}.jsonl`,
          hostAwake: true,
          ...(opts?.draft ? { draft: true } : {}),
        },
      },
    }));
    return sessionId;
  }

  it("切走空闲会话：发送 session.hibernate 并乐观标记 asleep", () => {
    const command = vi.fn(async () => ({}));
    vi.stubGlobal("window", { spcode: { command } });
    seedAwakeSession("hib-a");
    seedAwakeSession("hib-b");
    useStore.getState().setActive("hib-a"); // 当前激活 a，b 是从 a 切过来的目标

    useStore.getState().setActive("hib-b");
    expect(command).toHaveBeenCalledWith({ type: "session.hibernate", payload: { sessionId: "hib-a" } });
    expect(useStore.getState().sessions["hib-a"]?.hostAwake).toBe(false);
    expect(useStore.getState().activeSessionId).toBe("hib-b");
  });

  it("运行中的会话不休眠（hostAwake 保持 true，不发命令）", () => {
    const command = vi.fn(async () => ({}));
    vi.stubGlobal("window", { spcode: { command } });
    seedAwakeSession("hib-run", { running: true });
    seedAwakeSession("hib-idle");
    useStore.getState().setActive("hib-run");

    useStore.getState().setActive("hib-idle");
    expect(command).not.toHaveBeenCalledWith({ type: "session.hibernate", payload: { sessionId: "hib-run" } });
    expect(useStore.getState().sessions["hib-run"]?.hostAwake).toBe(true);
  });

  it("切回已休眠会话：发送 session.activate 唤醒并恢复 awake 标记", async () => {
    const command = vi.fn(async () => ({
      sessionFile: "/tmp/hib-wake.jsonl",
      model: null,
      thinkingLevel: "off",
      supportedThinkingLevels: [],
    }));
    vi.stubGlobal("window", { spcode: { command } });
    seedAwakeSession("hib-wake");
    seedAwakeSession("hib-other");
    useStore.getState().setActive("hib-wake");
    useStore.getState().setActive("hib-other"); // hib-wake 被休眠
    expect(useStore.getState().sessions["hib-wake"]?.hostAwake).toBe(false);

    useStore.getState().setActive("hib-wake"); // 切回 → 唤醒
    await vi.waitFor(() => expect(useStore.getState().sessions["hib-wake"]?.hostAwake).toBe(true));
    expect(command).toHaveBeenCalledWith({
      type: "session.activate",
      payload: { sessionId: "hib-wake", sessionFile: "/tmp/hib-wake.jsonl", cwd: "" },
    });
  });

  it("没有 sessionFile 的会话不参与休眠（无法唤醒的不能睡）", () => {
    const command = vi.fn(async () => ({}));
    vi.stubGlobal("window", { spcode: { command } });
    seedAwakeSession("hib-nofile");
    useStore.setState((s) => ({
      sessions: { ...s.sessions, "hib-nofile": { ...s.sessions["hib-nofile"]!, sessionFile: null } },
    }));
    seedAwakeSession("hib-target");
    useStore.getState().setActive("hib-nofile");

    useStore.getState().setActive("hib-target");
    expect(command).not.toHaveBeenCalledWith({ type: "session.hibernate", payload: { sessionId: "hib-nofile" } });
    expect(useStore.getState().sessions["hib-nofile"]?.hostAwake).toBe(true);
  });

  it("hibernate 命令失败：回滚 awake 标记", async () => {
    const command = vi.fn(async (cmd: { type: string }) => {
      if (cmd.type === "session.hibernate") throw new Error("host down");
      return {};
    });
    vi.stubGlobal("window", { spcode: { command } });
    seedAwakeSession("hib-fail");
    seedAwakeSession("hib-next");
    useStore.getState().setActive("hib-fail");

    useStore.getState().setActive("hib-next");
    await vi.waitFor(() => expect(useStore.getState().sessions["hib-fail"]?.hostAwake).toBe(true));
  });
});
