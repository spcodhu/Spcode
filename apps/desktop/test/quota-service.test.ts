import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLocale } from "@spcode/shared/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseKimiCodingUsages, QuotaService, quotaLimitOf } from "../src/main/quota-service.js";

beforeEach(() => setLocale("zh-CN"));
afterEach(() => {
  setLocale("zh-CN");
  vi.unstubAllGlobals();
});

describe("parseKimiCodingUsages", () => {
  it("renders English quotas, numbers, and reset dates at query time", () => {
    setLocale("en");
    const { limits } = parseKimiCodingUsages({
      usage: { limit: 12000 },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: 100, resetTime: "2099-12-15T12:00:00Z" },
        },
      ],
    });
    expect(limits[0]?.label).toBe("5-hour quota");
    expect(limits[0]?.text).toBe("Quota 100");
    expect(limits[0]?.resetText).toBe("Dec 15");
    expect(limits[1]?.label).toBe("Weekly quota");
    expect(limits[1]?.text).toBe("Quota 12.0K");
    expect(() => parseKimiCodingUsages({})).toThrow("No quota information");
    setLocale("zh-CN");
    expect(quotaLimitOf({ label: "raw", limit: 12000 })?.text).toBe("额度 1.2万");
  });

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

  // 回归：真实接口里窗口额度缺 remaining 时，旧实现算出 NaN%，配额页显示「剩余 NaN%」
  it("remaining 缺失时用 used 反推，绝不产生 NaN", () => {
    const body = {
      usage: { limit: "100", remaining: "60" },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "200", used: "50" },
        },
      ],
    };
    const { limits } = parseKimiCodingUsages(body);
    expect(limits[0]?.label).toBe("5 小时额度");
    expect(limits[0]?.usedPercent).toBeCloseTo(25);
    expect(limits[0]?.text).toBe("75%");
    for (const l of limits) {
      if (l.usedPercent !== null) expect(Number.isFinite(l.usedPercent)).toBe(true);
    }
  });

  it("remaining/used 都缺或为脏值时 usedPercent 降级为 null（文字行）", () => {
    const body = {
      usage: { limit: "100", remaining: "unlimited" },
      limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100" } }],
    };
    const { limits } = parseKimiCodingUsages(body);
    expect(limits).toHaveLength(2);
    for (const l of limits) {
      expect(l.usedPercent).toBeNull();
      expect(l.text).toBe("额度 100");
    }
  });

  it("窗口单位映射：小时/天/周不再一律叫窗口额度", () => {
    const body = {
      limits: [
        { window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: "10", remaining: "10" } },
        { window: { duration: 1, timeUnit: "TIME_UNIT_DAY" }, detail: { limit: "10", remaining: "10" } },
        { window: { duration: 30, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "10", remaining: "10" } },
        { window: { duration: 300, timeUnit: "TIME_UNIT_UNKNOWN" }, detail: { limit: "10", remaining: "10" } },
      ],
    };
    expect(parseKimiCodingUsages(body).limits.map((l) => l.label)).toEqual([
      "5 小时额度",
      "1 天额度",
      "30 分钟额度",
      "窗口额度",
    ]);
  });

  it("quotaLimitOf：非有限 limit 返回 null，usedPercent 始终有限或 null", () => {
    expect(quotaLimitOf({ label: "a", limit: "abc" })).toBeNull();
    expect(quotaLimitOf({ label: "a", limit: "0" })).toBeNull();
    const row = quotaLimitOf({ label: "a", limit: 100, remaining: "x" });
    expect(row?.usedPercent).toBeNull();
    expect(row?.text).toBe("额度 100");
    const over = quotaLimitOf({ label: "a", limit: 100, used: 250 });
    expect(over?.usedPercent).toBe(100);
    expect(over?.text).toBe("0%");
  });
});

describe("QuotaService locale cache", () => {
  it("invalidates localized cached rows and leaves provider errors untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spcode-quota-i18n-"));
    try {
      writeFileSync(
        join(dir, "auth.json"),
        JSON.stringify({
          "xiaomi-token-plan-cn": { type: "api_key", key: "test-key" },
          moonshot: { type: "api_key", key: "test-key" },
        }),
      );
      const fetchMock = vi.fn().mockRejectedValue(new Error("RAW_PROVIDER_ERROR 原文"));
      vi.stubGlobal("fetch", fetchMock);
      const svc = new QuotaService(dir, () => ({ tokens: 12000, requests: 2 }));
      const zh = await svc.queryAll();
      expect(zh[0]?.label).toContain("国内版");
      expect(zh[0]?.limits[0]?.text).toBe("1.2万 tokens · 2 次请求");
      expect(await svc.queryAll()).toBe(zh);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      setLocale("en");
      const en = await svc.queryAll();
      expect(en[0]?.label).toContain("China");
      expect(en[0]?.limits[0]?.label).toBe("Local usage in the last 7 days");
      expect(en[0]?.limits[0]?.text).toBe("12.0K tokens · 2 requests");
      expect(en[1]?.label).toBe("Kimi (Moonshot AI)");
      expect(en[1]?.error).toBe("RAW_PROVIDER_ERROR 原文");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not return a stale locale when the language changes during a provider request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spcode-quota-i18n-"));
    try {
      writeFileSync(join(dir, "auth.json"), JSON.stringify({ moonshot: { type: "api_key", key: "test-key" } }));
      const fetchMock = vi.fn().mockImplementation(async () => {
        setLocale("en");
        return { ok: true, json: async () => ({ data: { available_balance: 10 } }) };
      });
      vi.stubGlobal("fetch", fetchMock);
      const [row] = await new QuotaService(dir).queryAll();
      expect(row?.label).toBe("Kimi (Moonshot AI)");
      expect(row?.plan).toBe("Balance");
      expect(row?.limits[0]?.label).toBe("Available balance");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
