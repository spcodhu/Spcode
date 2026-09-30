import { describe, expect, it } from "vitest";
import { parseKimiCodingUsages } from "../src/main/quota-service.js";

describe("parseKimiCodingUsages", () => {
  it("解析窗口额度 + 每周额度", () => {
    // 真实响应结构（2026-09 探测）：limits[] 为滚动窗口，usage 为总量
    const body = {
      usage: { limit: "100", used: "37", remaining: "63", resetTime: "2026-10-03T03:47:54Z" },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "100", used: "54", remaining: "46", resetTime: "2026-09-28T17:47:54Z" },
        },
      ],
    };
    const { plan, limits } = parseKimiCodingUsages(body);
    expect(plan).toBe("Kimi For Coding");
    expect(limits).toHaveLength(2);
    // 窗口额度：300 分钟 = 5 小时，剩余 46%
    expect(limits[0]?.label).toBe("5 小时额度");
    expect(limits[0]?.usedPercent).toBeCloseTo(54);
    expect(limits[0]?.text).toBe("46%");
    // 每周额度：剩余 63%
    expect(limits[1]?.label).toBe("每周额度");
    expect(limits[1]?.usedPercent).toBeCloseTo(37);
    expect(limits[1]?.text).toBe("63%");
  });

  it("空响应抛错（交给上层降级为查询失败）", () => {
    expect(() => parseKimiCodingUsages({})).toThrow("无配额信息");
  });

  it("limit 为 0 的窗口被跳过", () => {
    const body = {
      usage: { limit: "100", remaining: "80", resetTime: "2026-10-03T00:00:00Z" },
      limits: [{ detail: { limit: "0", remaining: "0" } }],
    };
    const { limits } = parseKimiCodingUsages(body);
    expect(limits).toHaveLength(1);
    expect(limits[0]?.label).toBe("每周额度");
  });
});
