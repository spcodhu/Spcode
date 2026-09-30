/**
 * extractUsage 结构防御测试（评审 P1-3 回归）：
 * 对引擎事件结构零信任——缺 cost / 缺字段 / 非对象 usage 都不许抛异常。
 */
import { describe, expect, it } from "vitest";
import { extractUsage } from "../src/agent-host/session-controller.js";

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
