/**
 * extractUsage 结构防御测试（评审 P1-3 回归）：
 * 对引擎事件结构零信任——缺 cost / 缺字段 / 非对象 usage 都不许抛异常。
 */
import { describe, expect, it } from "vitest";
import { extractUsage, lastAssistantUsageForRing } from "../src/agent-host/session-controller.js";

const model = { provider: "p", modelId: "m" };

describe("extractUsage", () => {
  it("正常 assistant message_end → 完整提取", () => {
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: 1234567890,
        usage: {
          input: 10,
          output: 5,
          cacheRead: 3,
          cacheWrite: 2,
          cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
        },
      },
    };
    const rec = extractUsage(event as never, "s1", model);
    expect(rec?.input).toBe(10);
    expect(rec?.costTotal).toBeCloseTo(0.33);
    expect(rec?.timestamp).toBe(1234567890);
  });

  it("缺 cost 字段 → 成本归零不抛异常", () => {
    const event = {
      type: "message_end",
      message: { role: "assistant", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    };
    const rec = extractUsage(event as never, "s1", model);
    expect(rec?.costTotal).toBe(0);
    expect(rec?.input).toBe(1);
  });

  it("usage 非对象 / 缺失 → 返回 null", () => {
    expect(extractUsage({ type: "message_end", message: { role: "assistant" } } as never, "s1", model)).toBeNull();
    expect(
      extractUsage({ type: "message_end", message: { role: "assistant", usage: "x" } } as never, "s1", model),
    ).toBeNull();
  });

  it("非 assistant / 非 message_end / 无模型 → null", () => {
    expect(
      extractUsage({ type: "message_end", message: { role: "user", usage: {} } } as never, "s1", model),
    ).toBeNull();
    expect(extractUsage({ type: "agent_start" } as never, "s1", model)).toBeNull();
    expect(
      extractUsage({ type: "message_end", message: { role: "assistant", usage: {} } } as never, "s1", null),
    ).toBeNull();
  });
});

describe("lastAssistantUsageForRing（恢复会话的环初始化）", () => {
  const assistantWithUsage = (overrides: Record<string, unknown> = {}) => ({
    role: "assistant",
    provider: "p",
    model: "m",
    stopReason: "stop",
    timestamp: 2000,
    usage: {
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 30,
      cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
    },
    ...overrides,
  });

  it("取最后一条有效 assistant usage（含缓存写与输出，与环口径一致）", () => {
    const messages = [
      { role: "user", content: [] },
      assistantWithUsage({ timestamp: 1000, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
      assistantWithUsage({ timestamp: 2000 }),
    ];
    const u = lastAssistantUsageForRing("s1", messages, null);
    expect(u?.sessionId).toBe("s1");
    expect(u?.input).toBe(100);
    expect(u?.cacheWrite).toBe(30);
    expect(u?.output).toBe(20);
    expect(u?.model).toEqual({ provider: "p", modelId: "m" });
    expect(u?.timestamp).toBe(2000);
  });

  it("压缩点之前的 usage 作废返回 null（它反映的是压缩前的大上下文）", () => {
    const messages = [
      assistantWithUsage({ timestamp: 1000 }),
      { role: "compactionSummary", summary: "s", tokensBefore: 100000, timestamp: 1500 },
    ];
    expect(lastAssistantUsageForRing("s1", messages, null)).toBeNull();
  });

  it("压缩之后的新 usage 正常采用", () => {
    const messages = [
      assistantWithUsage({ timestamp: 1000 }),
      { role: "compactionSummary", summary: "s", tokensBefore: 100000, timestamp: 1500 },
      assistantWithUsage({ timestamp: 3000 }),
    ];
    const u = lastAssistantUsageForRing("s1", messages, null);
    expect(u?.timestamp).toBe(3000);
  });

  it("跳过 aborted/error 与全零 usage；缺 provider/model 时回落会话模型", () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const messages = [
      assistantWithUsage({ timestamp: 1000, stopReason: "aborted" }),
      assistantWithUsage({ timestamp: 1100, usage: zero }),
      { role: "assistant", timestamp: 1200, stopReason: "error", usage: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 } },
    ];
    expect(lastAssistantUsageForRing("s1", messages, model)).toBeNull();

    const noModel = [
      { role: "assistant", timestamp: 1000, stopReason: "stop", usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } },
    ];
    expect(lastAssistantUsageForRing("s1", noModel, model)?.model).toEqual(model);
    expect(lastAssistantUsageForRing("s1", noModel, null)).toBeNull();
  });
});
