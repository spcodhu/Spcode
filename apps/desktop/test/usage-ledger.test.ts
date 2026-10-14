import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageRecord } from "@spcode/shared";
import { afterAll, describe, expect, it } from "vitest";
import { UsageLedger } from "../src/main/usage-ledger.js";

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

  it("providerUsage 按厂商聚合近 7 日用量，无记录返回 null", () => {
    const ledger = new UsageLedger(dir);
    // 上面用例已写入 deepseek×2 + zai×1
    const ds = ledger.providerUsage("deepseek");
    expect(ds?.requests).toBe(2);
    // 记录1: 100+50+80+20=250；记录2: 100+70+80+20=270
    expect(ds?.tokens).toBe(520);
    expect(ledger.providerUsage("kimi-coding")).toBeNull();
  });

  it("aggregateRange：week 是近 7 个自然日而非最近 7 个活跃日", () => {
    const ledger = new UsageLedger(mkdtempSync(join(tmpdir(), "spcode-usage-range-")));
    const dayMs = 86_400_000;
    // 三个时间点：16 天前（窗口外）、3 天前（窗口内）、今天
    ledger.append(rec({ timestamp: Date.now() - 16 * dayMs, input: 1000 }));
    ledger.append(rec({ timestamp: Date.now() - 3 * dayMs, input: 100 }));
    ledger.append(rec({ input: 10 }));

    const week = ledger.aggregateRange("week");
    expect(week.total.count).toBe(2);
    expect(week.total.input).toBe(110);

    const all = ledger.aggregateRange("all");
    expect(all.total.count).toBe(3);
    expect(all.total.input).toBe(1110);

    const today = ledger.aggregateRange("today");
    expect(today.total.count).toBe(1);
    expect(today.total.input).toBe(10);
  });

  it("providerUsage：近 7 日是自然日窗口，窗口外的旧记录不计入", () => {
    const ledger = new UsageLedger(mkdtempSync(join(tmpdir(), "spcode-usage-provider-")));
    const dayMs = 86_400_000;
    ledger.append(rec({ timestamp: Date.now() - 16 * dayMs, input: 1000 }));
    ledger.append(rec({ input: 10 }));

    const ds = ledger.providerUsage("deepseek");
    expect(ds?.requests).toBe(1);
    // 只有窗口内那条：10+50+80+20=160
    expect(ds?.tokens).toBe(160);
  });
});
