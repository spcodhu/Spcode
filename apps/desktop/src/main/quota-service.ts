/**
 * 配额服务：各厂商 token plan / 余额查询适配器。
 *
 * 每厂商返回若干行额度（每日/每周/每月/余额…），供配额页逐行渲染进度条。
 * 查询失败降级为 error，UI 显示"查询失败"而不是空白。
 * 密钥从 pi 的 auth.json 读取（只读、脱敏不出进程）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSpcodeHome } from "@spcode/shared/node";

export interface QuotaLimit {
  /** 行标签：每日额度 / 每周额度 / 余额… */
  label: string;
  /** 已用百分比 0-100；null 表示无进度（如余额文本行） */
  usedPercent: number | null;
  /** 右侧主文本（如 "45%" / "¥32.50"） */
  text: string | null;
  /** 重置时间或补充说明（如 "21:21" / "10月22日"） */
  resetText: string | null;
}

export interface QuotaInfo {
  provider: string;
  label: string;
  configured: boolean;
  plan: string | null;
  limits: QuotaLimit[];
  updatedAt: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// 密钥读取（pi auth.json，只读）
// ---------------------------------------------------------------------------

function readAuthKeys(agentDir: string): Record<string, string> {
  const file = join(agentDir, "auth.json");
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    const out: Record<string, string> = {};
    collectKeys(raw, out);
    return out;
  } catch {
    return {};
  }
}

function collectKeys(node: unknown, out: Record<string, string>, providerHint?: string): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectKeys(item, out, providerHint);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > 8 && /key|token|secret/i.test(k) && providerHint) {
      out[providerHint] = v;
    } else if (typeof v === "string" && v.length > 8 && isProviderId(k)) {
      out[k] = v;
    } else if (v && typeof v === "object") {
      collectKeys(v, out, isProviderId(k) ? k : providerHint);
    }
  }
}

function isProviderId(s: string): boolean {
  return /^[a-z][a-z0-9-]{2,30}$/i.test(s) && !/^(version|type|kind)$/i.test(s);
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

/** Kimi For Coding /v1/usages 响应 → 额度行（导出供单测） */
export function parseKimiCodingUsages(body: unknown): { plan: string | null; limits: QuotaLimit[] } {
  const b = body as {
    usage?: { limit?: string; remaining?: string; resetTime?: string };
    limits?: { window?: { duration?: number; timeUnit?: string }; detail?: { limit?: string; remaining?: string; resetTime?: string } }[];
  };
  const rows: QuotaLimit[] = [];
  // 滚动窗口额度（如 300 分钟 = 5 小时窗口）
  for (const l of b?.limits ?? []) {
    const d = l?.detail;
    if (!d) continue;
    const limit = Number(d.limit);
    const remaining = Number(d.remaining);
    if (!(limit > 0)) continue;
    const usedPct = Math.max(0, ((limit - remaining) / limit) * 100);
    const hours = l.window?.duration && l.window.timeUnit === "TIME_UNIT_MINUTE" ? l.window.duration / 60 : null;
    rows.push({
      label: hours ? `${hours} 小时额度` : "窗口额度",
      usedPercent: usedPct,
      text: `${Math.round(100 - usedPct)}%`,
      resetText: d.resetTime ? formatReset(Date.parse(d.resetTime)) : null,
    });
  }
  // 总量额度（每周）
  const u = b?.usage;
  if (u && Number(u.limit) > 0) {
    const usedPct = Math.max(0, ((Number(u.limit) - Number(u.remaining)) / Number(u.limit)) * 100);
    rows.push({
      label: "每周额度",
      usedPercent: usedPct,
      text: `${Math.round(100 - usedPct)}%`,
      resetText: u.resetTime ? formatReset(Date.parse(u.resetTime)) : null,
    });
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
        limits?: { type?: string; usage?: number; currentValue?: number; remaining?: number; percentage?: number; nextResetTime?: number }[];
        level?: string;
      };
    };
    const d = data.data;
    if (!d) throw new Error("无配额信息");
    const rows: QuotaLimit[] = (d.limits ?? []).map((l) => {
      const pct = l.percentage ?? null;
      return {
        label: limitLabel(l.type),
        usedPercent: pct,
        text: pct != null ? `${Math.max(0, 100 - pct).toFixed(0)}%` : String(l.remaining ?? "—"),
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
      return { plan: "Token Plan", limits: [{ label: "额度", usedPercent: null, text: "暂不支持在线查询", resetText: null }] };
    }
    const used = data.used_quota ?? 0;
    const pct = data.total_quota > 0 ? Math.round((used / data.total_quota) * 100) : null;
    return {
      plan: "Token Plan",
      limits: [{ label: "总额度", usedPercent: pct, text: pct != null ? `${100 - pct}%` : null, resetText: null }],
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
