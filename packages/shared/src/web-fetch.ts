/**
 * WebFetch 抓取后端协议适配（当前仅 DeepSeek Fetch API）。
 *
 * 放在 shared 包里是因为两处都要用：
 * - 主进程：设置页「测试连接」IPC 发真实请求（executeFetch）；
 * - agent-host：WebFetch 工具执行（executeFetch）。
 *
 * 协议约定（DeepSeek 官方文档）：POST JSON {url} + Bearer 鉴权 → 200 {title, content(Markdown)}；
 * 错误为 OpenAI 兼容格式（error.message），402 余额不足 / 403 安全策略拒绝 / 404 目标不可抓取。
 * 注意：走 DeepSeek 抓取时请求由 DeepSeek 服务器发出，不经过本机 SSRF 防护（目标可用性由对方策略兜底）。
 */

import { extractErrorDetail } from "./advanced-search.js";
import type { WebFetchConfig } from "./index.js";

/** DeepSeek Fetch 默认端点（设置页选择 DeepSeek 后端时自动填充） */
export const DEEPSEEK_FETCH_ENDPOINT = "https://api.deepseek.com/v1/tools/fetch";

export interface FetchedPage {
  title: string;
  /** Markdown 正文；目标页无法提取正文时为空字符串（官方约定此时不计费） */
  content: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 配置是否完整到可以生效（session-controller / WebFetch 工具据此决定抓取后端） */
export function isWebFetchReady(config: WebFetchConfig | null | undefined): boolean {
  return !!config && !!config.baseUrl?.trim() && !!config.apiKey?.trim();
}

/** 解析成功响应为 {title, content}；字段缺失容错为空字符串（导出供单测） */
export function parseFetchResponse(json: unknown): FetchedPage {
  const obj = isPlainObject(json) ? json : {};
  return {
    title: typeof obj.title === "string" ? obj.title : "",
    content: typeof obj.content === "string" ? obj.content : "",
  };
}

/**
 * 执行一次抓取。抛 Error 表示失败（HTTP 错误 / 网络错误），
 * 调用方（WebFetch 工具 / 测试连接 IPC）决定回退内置抓取或直接呈现。
 */
export async function executeFetch(
  config: WebFetchConfig,
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<FetchedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(config.baseUrl, {
      method: "POST",
      redirect: "follow",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}${await extractErrorDetail(res)}`);
    return parseFetchResponse(await res.json());
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
