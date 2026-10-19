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
  return { label: "可用余额", usedPercent: null, text: `${currency ?? ""}${balance}`, resetText: null };
}

const deepseekAdapter: QuotaAdapter = {
  providerIds: ["deepseek"],
  label: "DeepSeek",
  async fetch(apiKey, signal) {
    const data = (await getJson("https://api.deepseek.com/user/balance", apiKey, signal)) as {
      balance_infos?: { currency?: string; total_balance?: string }[];
    };
    const info = data.balance_infos?.[0];
    if (!info) throw new Error("无余额信息");
    return {
      plan: "按量余额",
      limits: [balanceRow(info.total_balance ?? "?", info.currency === "CNY" ? "¥" : "$")],
    };
  },
};

const moonshotAdapter: QuotaAdapter = {
  providerIds: ["moonshot", "moonshotai", "moonshotai-cn", "kimi"],
  label: "Kimi（月之暗面）",
  async fetch(apiKey, signal) {
    const data = (await getJson("https://api.moonshot.cn/v1/users/me/balance", apiKey, signal)) as {
      data?: { available_balance?: number; voucher_balance?: number; cash_balance?: number };
    };
    const d = data.data;
    if (!d) throw new Error("无余额信息");
    return {
      plan: "余额",
      limits: [balanceRow((d.available_balance ?? 0).toFixed(2), "¥")],
    };
  },
};

/** 额度窗口时长 → 可读标签（未知单位回落「窗口额度」） */
function windowLabel(window?: { duration?: number; timeUnit?: string }): string {
  const d = toFinite(window?.duration);
  if (d === null || d <= 0) return "窗口额度";
  const unit = window?.timeUnit;
  if (unit === "TIME_UNIT_MINUTE") return d % 60 === 0 ? `${d / 60} 小时额度` : `${d} 分钟额度`;
  if (unit === "TIME_UNIT_HOUR") return `${d} 小时额度`;
  if (unit === "TIME_UNIT_DAY") return `${d} 天额度`;
  if (unit === "TIME_UNIT_WEEK") return `${d} 周额度`;
  return "窗口额度";
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
    text: pct === null ? `额度 ${formatTokens(limit)}` : `${Math.round(100 - pct)}%`,
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
      label: "每周额度",
      limit: u.limit,
      remaining: u.remaining,
      used: u.used,
      resetTime: u.resetTime,
    });
    if (row) rows.push(row);
  }
  if (rows.length === 0) throw new Error("无配额信息");
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
  label: "z.ai（GLM Coding Plan）",
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
    if (!d) throw new Error("无配额信息");
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
    if (rows.length === 0) rows.push({ label: "订阅等级", usedPercent: null, text: d.level ?? "—", resetText: null });
    return { plan: d.level ?? "Coding Plan", limits: rows };
  },
};

const dashscopeAdapter: QuotaAdapter = {
  providerIds: ["qwen", "dashscope", "alibaba", "qwen-token-plan"],
  label: "Qwen / 通义（DashScope）",
  async fetch(apiKey, signal) {
    const data = (await getJson(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/dashboard/billing/quota",
      apiKey,
      signal,
    ).catch(() => null)) as { total_quota?: number; used_quota?: number } | null;
    if (!data || data.total_quota == null) {
      return {
        plan: "Token Plan",
        limits: [{ label: "额度", usedPercent: null, text: "暂不支持在线查询", resetText: null }],
      };
    }
    const total = toFinite(data.total_quota);
    const used = toFinite(data.used_quota) ?? 0;
    const pct = total !== null && total > 0 ? usedPercentOf(total, (used / total) * 100) : null;
    return {
      plan: "Token Plan",
      limits: [
        {
          label: "总额度",
          usedPercent: pct,
          text: pct != null ? `${Math.round(100 - pct)}%` : null,
          resetText: null,
        },
      ],
    };
  },
};

function limitLabel(type?: string): string {
  if (!type) return "额度";
  const t = type.toLowerCase();
  if (t.includes("day") || t.includes("daily")) return "每日额度";
  if (t.includes("week")) return "每周额度";
  if (t.includes("month")) return "每月额度";
  if (t.includes("hour")) return `${type.replace(/[^0-9]/g, "")} 小时额度`;
  if (t.includes("token")) return "Token 额度";
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
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

const ADAPTERS: QuotaAdapter[] = [deepseekAdapter, moonshotAdapter, kimiCodingAdapter, zaiAdapter, dashscopeAdapter];

/** provider id → 展示名（未接入在线查询的厂商也要有可读名） */
const PROVIDER_LABELS: Record<string, string> = {
  "xiaomi-token-plan-cn": "Xiaomi MiMo Token Plan（国内版）",
  "xiaomi-token-plan-ams": "Xiaomi MiMo Token Plan（阿姆斯特丹）",
  "xiaomi-token-plan-sgp": "Xiaomi MiMo Token Plan（新加坡）",
  xiaomi: "Xiaomi MiMo",
  "kimi-coding": "Kimi For Coding",
};

/** 本地用量的最小信息（无在线查询时的兜底展示） */
export interface LocalUsage {
  tokens: number;
  requests: number;
}

function formatTokens(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return n.toLocaleString();
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
  private cache: { keysSignature: string; at: number; results: QuotaInfo[] } | null = null;
  private static readonly CACHE_TTL_MS = 60_000;

  async queryAll(opts?: { force?: boolean }): Promise<QuotaInfo[]> {
    const keys = readAuthKeys(this.agentDir);
    const keysSignature = JSON.stringify(keys);
    const cached = this.cache;
    if (
      !opts?.force &&
      cached &&
      cached.keysSignature === keysSignature &&
      Date.now() - cached.at < QuotaService.CACHE_TTL_MS
    ) {
      return cached.results;
    }
    const now = Date.now();
    const results = await Promise.all(
      Object.entries(keys).map(([providerId, apiKey]) => this.queryOne(providerId, apiKey, now)),
    );
    this.cache = { keysSignature, at: now, results };
    return results;
  }

  /** 单厂商查询：无在线适配器的用本地用量兜底；失败降级为 error 行 */
  private async queryOne(providerId: string, apiKey: string, now: number): Promise<QuotaInfo> {
    const adapter = ADAPTERS.find((a) => a.providerIds.includes(providerId));
    const label = adapter?.label ?? PROVIDER_LABELS[providerId] ?? providerId;
    if (!adapter) {
      const local = this.localUsage?.(providerId) ?? null;
      return {
        provider: providerId,
        label,
        configured: true,
        plan: "订阅额度暂不支持在线查询",
        limits: local
          ? [
              {
                label: "近 7 日本地用量",
                usedPercent: null,
                text: `${formatTokens(local.tokens)} tokens · ${local.requests} 次请求`,
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
