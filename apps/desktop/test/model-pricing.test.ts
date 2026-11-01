import { priceUsageSample, resolveUsageRecordPricing, sanitizeModelPricing, type UsageRecord } from "@spcode/shared";
import { describe, expect, it } from "vitest";

const rates = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 };

function record(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    sessionId: "s1",
    model: { provider: "custom", modelId: "m1" },
    timestamp: 1,
    input: 1_000_000,
    output: 100_000,
    cacheRead: 500_000,
    cacheWrite: 50_000,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    costTotal: 0,
    ...over,
  };
}

describe("模型计价", () => {
  it("四项 token 分别按 USD / 1M 计算并汇总", () => {
    const priced = priceUsageSample(record(), rates);
    expect(priced.costInput).toBe(2);
    expect(priced.costOutput).toBe(1);
    expect(priced.costCacheRead).toBe(0.1);
    expect(priced.costCacheWrite).toBe(0.2);
    expect(priced.costTotal).toBeCloseTo(3.3);
    expect(priced.input).toBe(1_000_000); // 原始 token 不被修改
  });

  it("用户覆盖优先于已有成本，显式全零也是有效价格", () => {
    const custom = resolveUsageRecordPricing(record({ costTotal: 99 }), {
      override: rates,
      defaultKnown: true,
    });
    expect(custom.costBasis).toBe("custom");
    expect(custom.costTotal).toBeCloseTo(3.3);

    const free = resolveUsageRecordPricing(record(), {
      override: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      defaultRates: rates,
      defaultKnown: false,
    });
    expect(free.costBasis).toBe("custom");
    expect(free.costTotal).toBe(0);
  });

  it("目录非零价可补齐新记录；已知零价与未知零价严格区分", () => {
    const fallback = resolveUsageRecordPricing(record(), { defaultRates: rates, defaultKnown: true });
    expect(fallback.costBasis).toBe("engine");
    expect(fallback.costTotal).toBeCloseTo(3.3);

    const knownFree = resolveUsageRecordPricing(record(), {
      defaultRates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      defaultKnown: true,
    });
    expect(knownFree.costBasis).toBe("engine");

    const unknown = resolveUsageRecordPricing(record(), {
      defaultRates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      defaultKnown: false,
    });
    expect(unknown.costBasis).toBe("unpriced");
    expect(unknown.costTotal).toBe(0);
  });

  it("设置清洗保留显式零价，丢弃缺字段、负数、NaN 与非法 key", () => {
    expect(
      sanitizeModelPricing({
        "p/free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        "p/negative": { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 },
        "p/missing": { input: 1 },
        "p/nan": { input: Number.NaN, output: 0, cacheRead: 0, cacheWrite: 0 },
        " ": rates,
      }),
    ).toEqual({ "p/free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(sanitizeModelPricing([])).toEqual({});
  });
});
