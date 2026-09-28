import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { UsageLedger } from "../src/main/usage-ledger.js";
import type { UsageRecord } from "@spcode/shared";

let dir = "";

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function rec(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    sessionId: "s1",
    model: { provider: "deepseek", modelId: "deepseek-chat" },
    timestamp: Date.now(),
    input: 100,
    output: 50,
    cacheRead: 80,
    cacheWrite: 20,
    costInput: 0.001,
    costOutput: 0.001,
    costCacheRead: 0.0002,
    costCacheWrite: 0.0003,
    costTotal: 0.0025,
    ...over,
  };
}

describe("UsageLedger", () => {
  it("追加并按日×模型聚合", () => {
    dir = mkdtempSync(join(tmpdir(), "spcode-usage-"));
    const ledger = new UsageLedger(dir);
    ledger.append(rec());
    ledger.append(rec({ model: { provider: "zai", modelId: "glm-4.6" }, costTotal: 0.01 }));
    ledger.append(rec({ sessionId: "s2", output: 70 }));

    const days = ledger.summarize(7);
    expect(days).toHaveLength(1);
    const day = days[0]!;
    expect(day.total.count).toBe(3);
    expect(day.total.input).toBe(300);
    expect(day.total.output).toBe(170);
    expect(day.total.cacheRead).toBe(240);
    expect(Object.keys(day.byModel)).toHaveLength(2);
    expect(day.byModel["deepseek/deepseek-chat"]?.count).toBe(2);
    expect(day.byModel["zai/glm-4.6"]?.costTotal).toBeCloseTo(0.01);
  });

  it("空目录返回空聚合，坏行被跳过", () => {
    const ledger = new UsageLedger(join(dir, "empty"));
    expect(ledger.summarize(7)).toHaveLength(0);
  });

  it("dateOf 按本地日期分桶", () => {
    expect(UsageLedger.dateOf(new Date(2026, 8, 28, 12, 0, 0).getTime())).toBe("2026-09-28");
  });
});
