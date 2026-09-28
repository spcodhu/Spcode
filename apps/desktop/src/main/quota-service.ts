/**
 * 配额服务：各厂商 token plan / 余额查询适配器。
 *
 * 设计：适配器接口统一返回 QuotaInfo；查询失败降级为 error 字段，
 * UI 显示"查询失败"而不是空白。密钥从 pi 的 auth.json 读取（只读）。
 *
 * 首批：z.ai / Moonshot / DeepSeek / Qwen(DashScope)。
 * 各厂接口无公开稳定文档，按已知端点实测接通，坏了只影响卡片不影响主流程。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SPCODE_HOME_DIRNAME } from "@spcode/shared";

export interface QuotaInfo {
  provider: string;
  label: string;
  /** 是否已配置密钥 */
  configured: boolean;
  /** 剩余额度文本（如 "¥32.50" / "82%"），查询失败为 null */
  remaining: string | null;
  /** 总额度文本（可选） */
  total?: string | null;
  /** 用量百分比 0-100（可选，用于进度条） */
  usedPercent?: number | null;
  /** 计划名称（如 Coding Plan） */
  plan?: string | null;
  error?: string;
}

// ---------------------------------------------------------------------------
// 密钥读取（pi auth.json，只读、脱敏不出进程）
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
  // 形态1: { "deepseek": { "key": "sk-..." } } 或 { "deepseek": "sk-..." }
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
  fetch(apiKey: string, signal?: AbortSignal): Promise<Omit<QuotaInfo, "provider" | "label" | "configured">>;
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

const deepseekAdapter: QuotaAdapter = {
  providerIds: ["deepseek"],
  label: "DeepSeek",
  async fetch(apiKey, signal) {
    const data = (await getJson("https://api.deepseek.com/user/balance", apiKey, signal)) as {
      balance_infos?: { currency?: string; total_balance?: string; topped_up_balance?: string }[];
    };
    const info = data.balance_infos?.[0];
    if (!info) return { remaining: null, error: "无余额信息" };
    return {
      remaining: `${info.currency === "CNY" ? "¥" : "$"}${info.total_balance ?? "?"}`,
      plan: "余额",
    };
  },
};

const moonshotAdapter: QuotaAdapter = {
  providerIds: ["moonshot", "moonshotai", "moonshotai-cn"],
  label: "Moonshot（月之暗面）",
  async fetch(apiKey, signal) {
    const data = (await getJson("https://api.moonshot.cn/v1/users/me/balance", apiKey, signal)) as {
      data?: { available_balance?: number; voucher_balance?: number; cash_balance?: number };
    };
    const d = data.data;
    if (!d) return { remaining: null, error: "无余额信息" };
    return {
      remaining: `¥${(d.available_balance ?? 0).toFixed(2)}`,
      plan: "余额",
    };
  },
};

const zaiAdapter: QuotaAdapter = {
  providerIds: ["zai", "z-ai", "zhipu", "bigmodel", "zai-coding", "zai-coding-cn"],
  label: "z.ai（GLM Coding Plan）",
  async fetch(apiKey, signal) {
    // GLM Coding Plan 配额监控端点（社区已知）
    const data = (await getJson("https://api.z.ai/api/monitor/usage/quota/limit", apiKey, signal)) as {
      data?: {
        limits?: { type?: string; usage?: number; currentValue?: number; remaining?: number; percentage?: number }[];
        level?: string;
      };
    };
    const d = data.data;
    if (!d) return { remaining: null, error: "无配额信息" };
    const tokenLimit = d.limits?.find((l) => /token/i.test(l.type ?? "")) ?? d.limits?.[0];
    if (!tokenLimit) {
      return { remaining: d.level ?? null, plan: "Coding Plan" };
    }
    const pct = tokenLimit.percentage ?? null;
    return {
      remaining: pct != null ? `${Math.max(0, 100 - pct).toFixed(0)}%` : String(tokenLimit.remaining ?? "?"),
      usedPercent: pct,
      plan: d.level ?? "Coding Plan",
    };
  },
};

const dashscopeAdapter: QuotaAdapter = {
  providerIds: ["qwen", "dashscope", "alibaba", "qwen-token-plan"],
  label: "Qwen / 通义（DashScope）",
  async fetch(apiKey, signal) {
    // DashScope 没有公开余额查询 REST；Coding Plan 走 quota 端点
    const data = (await getJson(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/dashboard/billing/quota",
      apiKey,
      signal,
    ).catch(() => null)) as { total_quota?: number; used_quota?: number } | null;
    if (!data || data.total_quota == null) {
      return { remaining: null, error: "该厂商暂不支持在线查询" };
    }
    const used = data.used_quota ?? 0;
    const pct = data.total_quota > 0 ? (used / data.total_quota) * 100 : null;
    return {
      remaining: pct != null ? `${Math.max(0, 100 - pct).toFixed(0)}%` : null,
      usedPercent: pct,
      plan: "Token Plan",
    };
  },
};

const ADAPTERS: QuotaAdapter[] = [deepseekAdapter, moonshotAdapter, zaiAdapter, dashscopeAdapter];

// ---------------------------------------------------------------------------
// 服务入口
// ---------------------------------------------------------------------------

export class QuotaService {
  private readonly agentDir: string;

  constructor(agentDir?: string) {
    this.agentDir = agentDir ?? join(homedir(), SPCODE_HOME_DIRNAME, "agent");
  }

  async queryAll(): Promise<QuotaInfo[]> {
    const keys = readAuthKeys(this.agentDir);
    const results: QuotaInfo[] = [];
    for (const adapter of ADAPTERS) {
      const apiKey = adapter.providerIds.map((id) => keys[id]).find((k) => !!k);
      const provider = adapter.providerIds[0] ?? "unknown";
      if (!apiKey) {
        results.push({ provider, label: adapter.label, configured: false, remaining: null });
        continue;
      }
      try {
        const info = await adapter.fetch(apiKey);
        results.push({ provider, label: adapter.label, configured: true, ...info });
      } catch (err) {
        results.push({
          provider,
          label: adapter.label,
          configured: true,
          remaining: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }
}
