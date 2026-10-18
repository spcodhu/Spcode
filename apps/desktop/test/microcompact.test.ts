/**
 * Microcompact 单测：
 * - findMicrocompactTargets 的边界/跳过逻辑（真实 SessionManager 投影数据）
 * - maybeMicrocompact 的触发条件、context_edit 落盘与投影生效、幂等性
 * SessionManager 用 pi 真实的 inMemory 实现——投影/context_edit 是引擎语义，断言引擎行为而非我们的想象。
 */
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { findMicrocompactTargets, maybeMicrocompact, placeholderText } from "../src/agent-host/microcompact.js";

const TS = 1730000000000;

function userMsg(text: string, t = 0) {
  return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: TS + t };
}
function assistantMsg(text: string, t = 0) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    provider: "test",
    model: "m1",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, totalTokens: 2 },
    stopReason: "stop" as const,
    timestamp: TS + t,
  };
}
function toolResult(id: string, chars: number, t = 0) {
  return {
    role: "toolResult" as const,
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text" as const, text: "x".repeat(chars) }],
    isError: false,
    timestamp: TS + t,
  };
}

/** 造 5 个 assistant 回合、每回合一个大工具结果（交替序列） */
function seedSession(sm: SessionManager, resultChars = 5000) {
  sm.appendMessage(userMsg("开始", 1));
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    sm.appendMessage(assistantMsg(`回合 ${i}`, 10 + i * 2));
    sm.appendMessage(toolResult(`t${i}`, resultChars, 11 + i * 2));
    ids.push(`t${i}`);
  }
  return ids;
}

describe("findMicrocompactTargets", () => {
  it("只折叠最近 3 个 assistant 回合之前的旧工具结果", () => {
    const sm = SessionManager.inMemory();
    seedSession(sm);
    const projection = sm.buildSessionProjection();
    const targets = findMicrocompactTargets(projection.entries, new Set());
    // 5 个回合，边界 = 倒数第 3 个 assistant（回合 2）；之前的 toolResult = t0、t1
    expect(targets).toHaveLength(2);
    expect(targets.every((t) => t.chars === 5000)).toBe(true);
  });

  it("不足 3 个 assistant 回合时没有目标", () => {
    const sm = SessionManager.inMemory();
    sm.appendMessage(userMsg("hi", 1));
    sm.appendMessage(assistantMsg("a", 2));
    sm.appendMessage(toolResult("t0", 99999, 3));
    const projection = sm.buildSessionProjection();
    expect(findMicrocompactTargets(projection.entries, new Set())).toHaveLength(0);
  });

  it("跳过已被编辑过的、过小的、已是占位符的结果", () => {
    const sm = SessionManager.inMemory();
    seedSession(sm);
    const projection = sm.buildSessionProjection();
    const targets = findMicrocompactTargets(projection.entries, new Set());
    // 模拟 t0 已被编辑（在 editedIds 集合里）
    const firstToolEntryId = targets[0]!.entryId;
    const rest = findMicrocompactTargets(projection.entries, new Set([firstToolEntryId]));
    expect(rest).toHaveLength(1);
  });

  it("小工具结果（< 600 字符）不值得折叠", () => {
    const sm = SessionManager.inMemory();
    seedSession(sm, /* resultChars */ 300);
    const projection = sm.buildSessionProjection();
    expect(findMicrocompactTargets(projection.entries, new Set())).toHaveLength(0);
  });
});

function fakeSession(sm: SessionManager, tokens: number, contextWindow = 200_000): { session: AgentSession; refreshed: { count: number } } {
  const refreshed = { count: 0 };
  const session = {
    model: { provider: "test", id: "m1", contextWindow },
    getContextUsage: () => ({ tokens, contextWindow, percent: (tokens / contextWindow) * 100 }),
    sessionManager: sm,
    refreshContext: () => {
      refreshed.count++;
    },
  } as unknown as AgentSession;
  return { session, refreshed };
}

describe("maybeMicrocompact", () => {
  const WINDOW = 200_000;
  const LINE = WINDOW - 16384; // 触发线 183,584；80% ≈ 146,867

  it("占用超过触发线 80% 时折叠旧工具结果，投影内容变为占位符", () => {
    const sm = SessionManager.inMemory();
    seedSession(sm);
    const { session, refreshed } = fakeSession(sm, LINE * 0.9);
    const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 40000 } });

    const n = maybeMicrocompact(session, settings);
    expect(n).toBe(2);
    expect(refreshed.count).toBe(1);

    // 投影里旧工具结果已是占位符，且占位符说明了去向
    const projection = sm.buildSessionProjection();
    const toolTexts = projection.messages
      .filter((m) => m.role === "toolResult")
      .map((m) => {
        const c = (m as { content?: unknown }).content;
        return Array.isArray(c) && c[0]?.type === "text" ? (c[0] as { text: string }).text : "";
      });
    expect(toolTexts.filter((t) => t.startsWith("[该工具结果已被上下文清理折叠"))).toHaveLength(2);
    // 最近 3 个回合的结果保持原文
    expect(toolTexts.filter((t) => t === "x".repeat(5000))).toHaveLength(3);

    // context_edit 是 append-only 落盘（原文还在原始 entry 里）
    const edits = sm.getBranch().filter((e) => e.type === "context_edit");
    expect(edits).toHaveLength(2);
  });

  it("占用低于触发线 80% 时不动", () => {
    const sm = SessionManager.inMemory();
    seedSession(sm);
    const { session, refreshed } = fakeSession(sm, LINE * 0.5);
    const n = maybeMicrocompact(session, SettingsManager.inMemory());
    expect(n).toBe(0);
    expect(refreshed.count).toBe(0);
  });

  it("自动压缩开关关闭时不动（跟随引擎开关语义）", () => {
    const sm = SessionManager.inMemory();
    seedSession(sm);
    const { session } = fakeSession(sm, LINE * 0.95);
    const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
    expect(maybeMicrocompact(session, settings)).toBe(0);
  });

  it("tokens=null（压缩刚发生）时不动；重复运行幂等不重复折叠", () => {
    const sm = SessionManager.inMemory();
    seedSession(sm);
    const settings = SettingsManager.inMemory();
    const nullUsage = {
      model: { provider: "test", id: "m1", contextWindow: WINDOW },
      getContextUsage: () => ({ tokens: null, contextWindow: WINDOW, percent: null }),
      sessionManager: sm,
      refreshContext: () => {},
    } as unknown as AgentSession;
    expect(maybeMicrocompact(nullUsage, settings)).toBe(0);

    // 第一次清扫后，branch 上已有 context_edit；再次触发也不重复折叠同一条
    const { session } = fakeSession(sm, LINE * 0.9);
    expect(maybeMicrocompact(session, settings)).toBe(2);
    expect(maybeMicrocompact(session, settings)).toBe(0);
    expect(sm.getBranch().filter((e) => e.type === "context_edit")).toHaveLength(2);
  });

  it("占位符文案告知原大小与重获路径", () => {
    const text = placeholderText(5000);
    expect(text).toContain("5.0k");
    expect(text).toContain("重新执行");
  });
});
