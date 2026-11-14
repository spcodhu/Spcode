/**
 * 运行错误处理单测：错误回合 → 错误卡；重试救回 → 无卡；用户取消 → 无卡；
 * 历史回放也要留痕（否则重启后「任务被中断」的痕迹彻底消失）。
 */
import { RUN_GUARD_CUSTOM_TYPE, type RunGuardPause } from "@spcode/shared";
import { setLocale } from "@spcode/shared/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveRunStatus } from "../src/renderer/src/run-status.js";
import {
  applySessionEvent,
  historyToMessages,
  makeRunErrorNotice,
  type SessionState,
  useStore,
} from "../src/renderer/src/store.js";

afterEach(() => {
  setLocale("zh-CN");
  vi.unstubAllGlobals();
});

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    meta: {
      id: "s1",
      mode: "chat",
      cwd: "",
      title: "t",
      model: null,
      thinkingLevel: "off",
      createdAt: 0,
      updatedAt: 0,
    },
    messages: [],
    running: true,
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
    ...overrides,
  };
}

const errorEnd = (errorMessage: string) => ({
  type: "message_end",
  message: { role: "assistant", content: [], stopReason: "error", errorMessage },
});

describe("运行保护暂停错误卡", () => {
  const pause: RunGuardPause = {
    reason: "repeatTool",
    turnCount: 5,
    toolName: "read",
    repeatCount: 5,
    argumentsPreview: '{"path":"README.md"}',
  };

  it("session.runGuard → agent_settled 复用 runError 卡，保留结构化续跑信息", () => {
    const s = makeSession();
    useStore.setState({ sessions: { s1: s }, registrySessions: [] });
    useStore.getState().applyHostEvent({ type: "session.runGuard", sessionId: "s1", pause });
    expect(useStore.getState().sessions.s1?.pendingGuard).toEqual(pause);
    useStore.getState().applyHostEvent({
      type: "session.event",
      sessionId: "s1",
      event: { type: "agent_settled" },
    });
    const card = useStore.getState().sessions.s1?.messages.find((message) => message.notice?.kind === "runError");
    expect(card?.notice).toMatchObject({
      kind: "runError",
      errorKind: "repeatTool",
      guard: pause,
    });
    expect(card?.notice?.kind === "runError" && card.notice.raw).toContain("read");
    const settled = useStore.getState().sessions.s1;
    expect(settled?.pendingGuard).toBeUndefined();
    expect(settled?.running).toBe(false);
  });

  it("自定义会话消息在历史回放时还原为相同错误卡；提醒与坏数据不显示", () => {
    const out = historyToMessages([
      {
        role: "custom",
        customType: RUN_GUARD_CUSTOM_TYPE,
        content: "pause",
        display: false,
        details: { kind: "pause", pause },
      },
      {
        role: "custom",
        customType: RUN_GUARD_CUSTOM_TYPE,
        content: "reminder",
        display: false,
        details: { kind: "reminder", toolName: "read", repeatCount: 3 },
      },
      { role: "custom", customType: RUN_GUARD_CUSTOM_TYPE, content: "bad", display: false, details: { kind: "pause" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.notice).toMatchObject({ kind: "runError", errorKind: "repeatTool", guard: pause });
  });

  it("最大回合暂停也回放到 runError 卡", () => {
    const maxPause: RunGuardPause = { reason: "maxTurns", turnCount: 2000, limit: 2000 };
    const out = historyToMessages([
      {
        role: "custom",
        customType: RUN_GUARD_CUSTOM_TYPE,
        content: "pause",
        display: false,
        details: { kind: "pause", pause: maxPause },
      },
    ]);
    expect(out[0]?.notice).toMatchObject({ kind: "runError", errorKind: "maxTurns", guard: maxPause });
  });

  it("继续按钮的 store 动作调用 session.continue，不重发原始用户指令", async () => {
    const command = vi.fn(async () => ({ accepted: true }));
    vi.stubGlobal("window", { spcode: { command } });
    useStore.setState({ sessions: { s1: makeSession({ running: false }) }, registrySessions: [] });
    await useStore.getState().continueRun("s1");
    expect(command).toHaveBeenCalledWith({ type: "session.continue", payload: { sessionId: "s1" } });
  });

  it("切换语言时标题、建议和详情一起重本地化，保留暂停语义", () => {
    setLocale("zh-CN");
    const card = historyToMessages([
      {
        role: "custom",
        customType: RUN_GUARD_CUSTOM_TYPE,
        content: "pause",
        display: false,
        details: { kind: "pause", pause },
      },
    ])[0]!;
    useStore.setState({ sessions: { s1: makeSession({ messages: [card] }) }, registrySessions: [] });
    useStore.getState().applyHostEvent({ type: "locale.changed", locale: "en" });
    const updated = useStore.getState().sessions.s1?.messages[0];
    expect(updated?.notice?.kind === "runError" ? updated.notice.title : "").toMatch(/tool-call loop/i);
    expect(updated?.notice?.kind === "runError" ? updated.notice.raw : "").toMatch(/Consecutive identical calls/i);
    expect(updated?.notice?.kind === "runError" ? updated.notice.guard : undefined).toEqual(pause);
  });
});

describe("applySessionEvent：错误回合的可见性", () => {
  it("外部入口的用户消息同时还原文本与图片，供错误重试复用", () => {
    const s = makeSession();
    applySessionEvent(s, {
      type: "message_end",
      message: {
        role: "user",
        content: [
          { type: "text", text: "看图片" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      },
    });
    expect(s.messages[0]).toMatchObject({
      role: "user",
      images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
    });
  });

  it("额度不足回合：agent_settled 落一张 runError 卡，且空 assistant 占位被清掉", () => {
    const s = makeSession();
    applySessionEvent(s, { type: "agent_start" });
    applySessionEvent(s, errorEnd("402 Insufficient Balance"));
    // 还没结束：先不落卡（重试可能救回）
    expect(s.messages.every((m) => m.notice?.kind !== "runError")).toBe(true);
    expect(s.pendingError?.message).toContain("Insufficient Balance");

    applySessionEvent(s, { type: "agent_settled" });
    const card = s.messages.find((m) => m.notice?.kind === "runError");
    expect(card).toBeTruthy();
    expect(card?.notice?.kind === "runError" && card.notice.errorKind).toBe("quota");
    // 空 assistant 消息不该留下（旧实现会渲染一块空白）
    expect(s.messages.some((m) => m.role === "assistant")).toBe(false);
    expect(s.running).toBe(false);
  });

  it("重试救回（成功 stop 回合）：不留错误卡、retry 状态被清", () => {
    const s = makeSession();
    applySessionEvent(s, { type: "agent_start" });
    applySessionEvent(s, errorEnd("429 rate limit"));
    applySessionEvent(s, { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "429" });
    expect(s.retry?.attempt).toBe(1);
    applySessionEvent(s, { type: "auto_retry_end", success: true, attempt: 1 });
    expect(s.retry).toBeUndefined();
    applySessionEvent(s, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "好了" }], stopReason: "stop" },
    });
    applySessionEvent(s, { type: "agent_settled" });
    expect(s.messages.some((m) => m.notice?.kind === "runError")).toBe(false);
    expect(s.messages.some((m) => m.role === "assistant")).toBe(true);
  });

  it("用户在重试退避中取消：不留错误卡", () => {
    const s = makeSession();
    applySessionEvent(s, { type: "agent_start" });
    applySessionEvent(s, errorEnd("429 rate limit"));
    applySessionEvent(s, { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "429" });
    applySessionEvent(s, { type: "auto_retry_end", success: false, finalError: "Retry cancelled" });
    applySessionEvent(s, { type: "agent_settled" });
    expect(s.messages.some((m) => m.notice?.kind === "runError")).toBe(false);
  });

  it("重试耗尽后的最终错误：带上错误原因与重试次数", () => {
    const s = makeSession();
    applySessionEvent(s, { type: "agent_start" });
    applySessionEvent(s, errorEnd("503 Service Unavailable"));
    applySessionEvent(s, { type: "auto_retry_start", attempt: 3, maxAttempts: 3, delayMs: 8000, errorMessage: "503" });
    applySessionEvent(s, {
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "503 Service Unavailable",
    });
    applySessionEvent(s, { type: "agent_settled" });
    const card = s.messages.find((m) => m.notice?.kind === "runError");
    expect(card?.notice?.kind === "runError" && card.notice.raw).toBe("503 Service Unavailable");
    expect(card?.notice?.kind === "runError" && card.notice.attempt).toBe(3);
    // 卡片正文要能读到「重试 3 次后仍失败」
    expect(card ? JSON.stringify(card.segments) : "").toContain("重试 3 次后仍失败");
  });

  it("重试中状态条显示重试进度与原因摘要", () => {
    const s = makeSession({ retry: { attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: "429 rate limit" } });
    const status = deriveRunStatus(s, [], [], "s1");
    expect(status?.kind).toBe("retry");
    expect(status?.label).toContain("4s");
    expect(status?.label).toContain("2/3");
    expect(status?.detail).toContain("429");
  });
});

describe("locale changes", () => {
  it("relocalizes app-owned error-card copy while preserving the raw provider error", () => {
    setLocale("zh-CN");
    const card = makeRunErrorNotice("402 Insufficient Balance", 2);
    useStore.setState({ sessions: { s1: makeSession({ messages: [card] }) }, registrySessions: [] });
    useStore.getState().applyHostEvent({ type: "locale.changed", locale: "en" });
    const updated = useStore.getState().sessions.s1?.messages[0];
    expect(JSON.stringify(updated?.segments)).toContain("retries");
    expect(updated?.notice?.kind === "runError" ? updated.notice.title : "").toMatch(/quota/i);
    expect(updated?.notice?.kind === "runError" ? updated.notice.raw : "").toBe("402 Insufficient Balance");
    expect(updated?.notice?.kind === "runError" ? updated.notice.hint : "").not.toMatch(/[\u4e00-\u9fff]/);
  });
});

describe("historyToMessages：错误回合重启后仍留痕", () => {
  it("stopReason=error 的空内容消息回放为 runError 通知", () => {
    const out = historyToMessages([
      { role: "user", content: [{ type: "text", text: "跑一下测试" }] },
      { role: "assistant", content: [], stopReason: "error", errorMessage: "402 Insufficient Balance" },
    ]);
    expect(out).toHaveLength(2);
    const notice = out[1];
    expect(notice?.role).toBe("notice");
    expect(notice?.notice?.kind).toBe("runError");
    expect(notice?.notice?.kind === "runError" && notice.notice.errorKind).toBe("quota");
  });

  it("错误回合已流出一部分正文时：正文保留，错误卡跟在后面", () => {
    const out = historyToMessages([
      { role: "assistant", content: [{ type: "text", text: "我先看下" }], stopReason: "error", errorMessage: "429" },
    ]);
    expect(out.map((m) => m.role)).toEqual(["assistant", "notice"]);
  });
});
