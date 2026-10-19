/**
 * 运行错误处理单测：错误回合 → 错误卡；重试救回 → 无卡；用户取消 → 无卡；
 * 历史回放也要留痕（否则重启后「任务被中断」的痕迹彻底消失）。
 */
import { describe, expect, it } from "vitest";
import { deriveRunStatus } from "../src/renderer/src/run-status.js";
import { applySessionEvent, historyToMessages, type SessionState } from "../src/renderer/src/store.js";

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

describe("applySessionEvent：错误回合的可见性", () => {
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
