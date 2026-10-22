/**
 * 配额服务：各厂商 token plan / 余额查询适配器。
 *
 * 每厂商返回若干行额度（每日/每周/每月/余额…），供配额页逐行渲染进度条。
 * 查询失败降级为 error，UI 显示"查询失败"而不是空白。
 * 密钥从 pi 的 auth.json 读取（只读、脱敏不出进程）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { QuotaInfo, QuotaLimit } from "@spcode/shared";
import { getLocale, i18n } from "@spcode/shared/i18n";
import { resolveSpcodeHome } from "@spcode/shared/node";

// 类型已下沉 shared（评审 R3-C12）；本文件保留 re-export 兼容 preload/页面引用
export type { QuotaInfo, QuotaLimit } from "@spcode/shared";

// ---------------------------------------------------------------------------
// 密钥读取（pi auth.json，只读）
// ---------------------------------------------------------------------------

/**
 * 从 pi auth.json 提取各厂商密钥（评审 R3-C15：按 pi 的凭证 schema 精确读取，
 * 不再用 /key|token|secret/ 启发式猜——后者遇到非标准字段会把普通字符串当 key 发给第三方）。
 * 支持的形态：{ provider: { type: "api_key", key } } 与 { provider: { type: "oauth", accessToken/refreshToken } }。
 */
function readAuthKeys(agentDir: string): Record<string, string> {
  const file = join(agentDir, "auth.json");
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [providerId, cred] of Object.entries(raw as Record<string, unknown>)) {
      if (!cred || typeof cred !== "object" || Array.isArray(cred)) continue;
      const c = cred as Record<string, unknown>;
      if (c.type === "api_key" && typeof c.key === "string" && c.key) {
        out[providerId] = c.key;
      } else if (c.type === "oauth") {
        const token =
          typeof c.accessToken === "string"
            ? c.accessToken
            : typeof c.refreshToken === "string"
              ? c.refreshToken
              : null;
        if (token) out[providerId] = token;
      }
    }
    return out;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

interface QuotaAdapter {
  providerIds: string[];
  label: string;
  fetch(apiKey: string, signal?: AbortSignal): Promise<{ plan: string | null; limits: QuotaLimit[] }>;
}

const TIMEOUT = 12000;

async function getJson(url: string, apiKey: string, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 宽进严出地取数值：上游额度接口的字段类型不稳定（数字/数字字符串/缺字段/带单位字符串）。
 * 无法解析成有限数一律返回 null——绝不让 NaN 流进 usedPercent（配额页曾显示「剩余 NaN%」）。
 */
function toFinite(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 已用百分比：clamp 到 0..100，非有限值返回 null（调用方降级为文字行） */
function usedPercentOf(limit: number, used: number | null): number | null {
  if (used === null || !Number.isFinite(used) || !(limit > 0)) return null;
  return Math.min(100, Math.max(0, used));
}

function balanceRow(balance: string, currency?: string): QuotaLimit {
  return {
    label: i18n.t("main:quota.availableBalance"),
    usedPercent: null,
    text: `${currency ?? ""}${balance}`,
    resetText: null,
  };
}

const deepseekAdapter: QuotaAdapter = {
  providerIds: ["deepseek"],
  label: "DeepSeek",
  async fetch(apiKey, signal) {
    const data = (await getJson("https://api.deepseek.com/user/balance", apiKey, signal)) as {
      balance_infos?: { currency?: string; total_balance?: string }[];
    };
    const info = data.balance_infos?.[0];
    if (!info) throw new Error(i18n.t("main:quota.noBalance"));
    return {
      plan: i18n.t("main:quota.payAsYouGo"),
      limits: [balanceRow(info.total_balance ?? "?", info.currency === "CNY" ? "¥" : "$")],
    };
  },
};

const moonshotAdapter: QuotaAdapter = {
  providerIds: ["moonshot", "moonshotai", "moonshotai-cn", "kimi"],
  get label() {
    return i18n.t("main:quota.provider.moonshot");
  },
  async fetch(apiKey, signal) {
    const data = (await getJson("https://api.moonshot.cn/v1/users/me/balance", apiKey, signal)) as {
      data?: { available_balance?: number; voucher_balance?: number; cash_balance?: number };
    };
    const d = data.data;
    if (!d) throw new Error(i18n.t("main:quota.noBalance"));
    return {
      plan: i18n.t("main:quota.balance"),
      limits: [balanceRow((d.available_balance ?? 0).toFixed(2), "¥")],
    };
  },
};

/** 额度窗口时长 → 可读标签（未知单位回落「窗口额度」） */
function windowLabel(window?: { duration?: number; timeUnit?: string }): string {
  const d = toFinite(window?.duration);
  if (d === null || d <= 0) return i18n.t("main:quota.window");
  const unit = window?.timeUnit;
  if (unit === "TIME_UNIT_MINUTE") {
    return d % 60 === 0 ? i18n.t("main:quota.hours", { count: d / 60 }) : i18n.t("main:quota.minutes", { count: d });
  }
  if (unit === "TIME_UNIT_HOUR") return i18n.t("main:quota.hours", { count: d });
  if (unit === "TIME_UNIT_DAY") return i18n.t("main:quota.days", { count: d });
  if (unit === "TIME_UNIT_WEEK") return i18n.t("main:quota.weeks", { count: d });
  return i18n.t("main:quota.window");
}

/**
 * 单行额度的口径归一（导出供单测）：
 * remaining 优先 → 否则用 used 反推 → 两者都不可用则 usedPercent=null（文字行，不产生 NaN）。
 */
export function quotaLimitOf(args: {
  label: string;
  limit: unknown;
  remaining?: unknown;
  used?: unknown;
  resetTime?: string;
}): QuotaLimit | null {
  const limit = toFinite(args.limit);
  if (limit === null || limit <= 0) return null;
  const remaining = toFinite(args.remaining);
  const used = toFinite(args.used);
  let usedPct: number | null = null;
  if (remaining !== null) usedPct = ((limit - remaining) / limit) * 100;
  else if (used !== null) usedPct = (used / limit) * 100;
  const pct = usedPct === null ? null : usedPercentOf(limit, usedPct);
  return {
    label: args.label,
    usedPercent: pct,
    // usedPercent 未知时给出原始额度量，避免整行只剩一个标签
    text: pct === null ? i18n.t("main:quota.amount", { amount: formatTokens(limit) }) : `${Math.round(100 - pct)}%`,
    resetText: args.resetTime ? formatReset(Date.parse(args.resetTime)) : null,
  };
}

/** Kimi For Coding /v1/usages 响应 → 额度行（导出供单测） */
export function parseKimiCodingUsages(body: unknown): { plan: string | null; limits: QuotaLimit[] } {
  const b = body as {
    usage?: { limit?: unknown; remaining?: unknown; used?: unknown; resetTime?: string };
    limits?: {
      window?: { duration?: number; timeUnit?: string };
      detail?: { limit?: unknown; remaining?: unknown; used?: unknown; resetTime?: string };
    }[];
  };
  const rows: QuotaLimit[] = [];
  // 滚动窗口额度（如 300 分钟 = 5 小时窗口）
  for (const l of b?.limits ?? []) {
    const d = l?.detail;
    if (!d) continue;
    const row = quotaLimitOf({
      label: windowLabel(l.window),
      limit: d.limit,
      remaining: d.remaining,
      used: d.used,
      resetTime: d.resetTime,
    });
    if (row) rows.push(row);
  }
  // 总量额度（每周）
  const u = b?.usage;
  if (u) {
    const row = quotaLimitOf({
      label: i18n.t("main:quota.weekly"),
      limit: u.limit,
      remaining: u.remaining,
      used: u.used,
      resetTime: u.resetTime,
    });
    if (row) rows.push(row);
  }
  if (rows.length === 0) throw new Error(i18n.t("main:quota.noQuota"));
  return { plan: "Kimi For Coding", limits: rows };
}

const kimiCodingAdapter: QuotaAdapter = {
  providerIds: ["kimi-coding"],
  label: "Kimi For Coding",
  async fetch(apiKey, signal) {
    const body = await getJson("https://api.kimi.com/coding/v1/usages", apiKey, signal);
    return parseKimiCodingUsages(body);
  },
};

const zaiAdapter: QuotaAdapter = {
  providerIds: ["zai", "z-ai", "zhipu", "bigmodel", "zai-coding", "zai-coding-cn", "glm"],
  get label() {
    return i18n.t("main:quota.provider.zai");
  },
  async fetch(apiKey, signal) {
    const data = (await getJson("https://api.z.ai/api/monitor/usage/quota/limit", apiKey, signal)) as {
      data?: {
        limits?: {
          type?: string;
          usage?: number;
          currentValue?: number;
          remaining?: number;
          percentage?: number;
          nextResetTime?: number;
        }[];
        level?: string;
      };
    };
    const d = data.data;
    if (!d) throw new Error(i18n.t("main:quota.noQuota"));
    const rows: QuotaLimit[] = (d.limits ?? []).map((l) => {
      // percentage 可能是 null/NaN/字符串：非有限值降级为未知（不渲染 NaN%）
      const pct = usedPercentOf(100, toFinite(l.percentage));
      return {
        label: limitLabel(l.type),
        usedPercent: pct,
        text: pct != null ? `${Math.round(100 - pct)}%` : String(l.remaining ?? "—"),
        resetText: l.nextResetTime ? formatReset(l.nextResetTime) : null,
      };
    });
    if (rows.length === 0)
      rows.push({
        label: i18n.t("main:quota.subscriptionTier"),
        usedPercent: null,
        text: d.level ?? "—",
        resetText: null,
      });
    return { plan: d.level ?? "Coding Plan", limits: rows };
  },
};

const dashscopeAdapter: QuotaAdapter = {
  providerIds: ["qwen", "dashscope", "alibaba", "qwen-token-plan"],
  get label() {
    return i18n.t("main:quota.provider.qwen");
  },
  async fetch(apiKey, signal) {
    const data = (await getJson(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/dashboard/billing/quota",
      apiKey,
      signal,
    ).catch(() => null)) as { total_quota?: number; used_quota?: number } | null;
    if (!data || data.total_quota == null) {
      return {
        plan: "Token Plan",
        limits: [
          {
            label: i18n.t("main:quota.limit"),
            usedPercent: null,
            text: i18n.t("main:quota.onlineUnsupported"),
            resetText: null,
          },
        ],
      };
    }
    const total = toFinite(data.total_quota);
    const used = toFinite(data.used_quota) ?? 0;
    const pct = total !== null && total > 0 ? usedPercentOf(total, (used / total) * 100) : null;
    return {
      plan: "Token Plan",
      limits: [
        {
          label: i18n.t("main:quota.total"),
          usedPercent: pct,
          text: pct != null ? `${Math.round(100 - pct)}%` : null,
          resetText: null,
        },
      ],
    };
  },
};

function limitLabel(type?: string): string {
  if (!type) return i18n.t("main:quota.limit");
  const t = type.toLowerCase();
  if (t.includes("day") || t.includes("daily")) return i18n.t("main:quota.daily");
  if (t.includes("week")) return i18n.t("main:quota.weekly");
  if (t.includes("month")) return i18n.t("main:quota.monthly");
  if (t.includes("hour")) {
    const hours = type.replace(/[^0-9]/g, "");
    return hours ? i18n.t("main:quota.hours", { count: Number(hours) }) : i18n.t("main:quota.window");
  }
  if (t.includes("token")) return i18n.t("main:quota.tokens");
  return type;
}

function formatReset(ts: number): string {
  // 评审 R3-C15：上游 resetTime 解析失败（NaN）不输出「NaN月NaN日」
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  const now = Date.now();
  if (d.getTime() - now < 86_400_000) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return d.toLocaleDateString(getLocale(), { month: getLocale() === "zh-CN" ? "long" : "short", day: "numeric" });
}

const ADAPTERS: QuotaAdapter[] = [deepseekAdapter, moonshotAdapter, kimiCodingAdapter, zaiAdapter, dashscopeAdapter];

/** provider id → 展示名（未接入在线查询的厂商也要有可读名） */
function providerLabel(providerId: string): string {
  switch (providerId) {
    case "xiaomi-token-plan-cn":
      return i18n.t("main:quota.provider.xiaomiCn");
    case "xiaomi-token-plan-ams":
      return i18n.t("main:quota.provider.xiaomiAms");
    case "xiaomi-token-plan-sgp":
      return i18n.t("main:quota.provider.xiaomiSgp");
    case "xiaomi":
      return "Xiaomi MiMo";
    case "kimi-coding":
      return "Kimi For Coding";
    default:
      return providerId;
  }
}

/** 本地用量的最小信息（无在线查询时的兜底展示） */
export interface LocalUsage {
  tokens: number;
  requests: number;
}

function formatTokens(n: number): string {
  const locale = getLocale();
  return new Intl.NumberFormat(
    locale,
    n >= (locale === "zh-CN" ? 10000 : 1000)
      ? { notation: "compact", minimumFractionDigits: 1, maximumFractionDigits: 1 }
      : {},
  ).format(n);
}

// ---------------------------------------------------------------------------
// 服务入口
// ---------------------------------------------------------------------------

export class QuotaService {
  private readonly agentDir: string;
  private readonly localUsage?: (providerId: string) => LocalUsage | null;

  constructor(agentDir?: string, localUsage?: (providerId: string) => LocalUsage | null) {
    this.agentDir = agentDir ?? join(resolveSpcodeHome(), "agent");
    this.localUsage = localUsage;
  }

  /**
   * 只返回已配置密钥的厂商（未配置的不占位）。
   * 有在线适配器的查在线额度；没有的（如小米 Token Plan）用本地用量兜底。
   * QuotaInfo.provider 为真实 provider id，供 Composer 配额圆环精确匹配。
   *
   * 评审 P1-9：各厂商并发查询（原串行最坏 12s × N）；结果缓存 60s，
   * 密钥集合变化自动失效，force 强制刷新。
   */
  private cache: {
    keysSignature: string;
    locale: ReturnType<typeof getLocale>;
    at: number;
    results: QuotaInfo[];
  } | null = null;
  private static readonly CACHE_TTL_MS = 60_000;

  async queryAll(opts?: { force?: boolean }): Promise<QuotaInfo[]> {
    const keys = readAuthKeys(this.agentDir);
    const keysSignature = JSON.stringify(keys);
    const locale = getLocale();
    const cached = this.cache;
    if (
      !opts?.force &&
      cached &&
      cached.keysSignature === keysSignature &&
      cached.locale === locale &&
      Date.now() - cached.at < QuotaService.CACHE_TTL_MS
    ) {
      return cached.results;
    }
    const now = Date.now();
    const results = await Promise.all(
      Object.entries(keys).map(([providerId, apiKey]) => this.queryOne(providerId, apiKey, now)),
    );
    // A locale switch during an async provider request must not return mixed-language rows.
    if (getLocale() !== locale) return this.queryAll({ force: true });
    this.cache = { keysSignature, locale, at: now, results };
    return results;
  }

  /** 单厂商查询：无在线适配器的用本地用量兜底；失败降级为 error 行 */
  private async queryOne(providerId: string, apiKey: string, now: number): Promise<QuotaInfo> {
    const adapter = ADAPTERS.find((a) => a.providerIds.includes(providerId));
    const label = adapter?.label ?? providerLabel(providerId);
    if (!adapter) {
      const local = this.localUsage?.(providerId) ?? null;
      return {
        provider: providerId,
        label,
        configured: true,
        plan: i18n.t("main:quota.subscriptionUnsupported"),
        limits: local
          ? [
              {
                label: i18n.t("main:quota.localUsage"),
                usedPercent: null,
                text: i18n.t("main:quota.usage", { tokens: formatTokens(local.tokens), count: local.requests }),
                resetText: null,
              },
            ]
          : [],
        updatedAt: now,
      };
    }
    try {
      const { plan, limits } = await adapter.fetch(apiKey);
      return { provider: providerId, label, configured: true, plan, limits, updatedAt: now };
    } catch (err) {
      return {
        provider: providerId,
        label,
        configured: true,
        plan: null,
        limits: [],
        updatedAt: now,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
