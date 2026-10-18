/**
 * 高级搜索：协议适配层（Tavily / 博查 Bocha / 自定义）。
 *
 * 放在 shared 包里是因为三处都要用：
 * - 渲染进程设置页：inferMapping 实时校验用户粘贴的响应示例；
 * - 主进程：「测试连接」IPC 发真实请求（executeSearch）；
 * - agent-host：AdvancedSearch 工具执行（executeSearch）。
 *
 * 请求侧统一约定：POST JSON + Bearer 鉴权。
 * 响应侧：tavily/bocha 走固定解析；custom 用从示例 JSON 推断出的 mapping 解析。
 */
import type { AdvancedSearchConfig, AdvancedSearchMapping } from "./index.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 预设协议的默认端点（设置页切换预设时自动填充 baseUrl） */
export const PRESET_ENDPOINTS: Record<"tavily" | "bocha", string> = {
  tavily: "https://api.tavily.com/search",
  bocha: "https://api.bochaai.com/v1/web-search",
};

/** 配置是否完整到可以生效（session-controller 据此决定是否注册 AdvancedSearch 工具） */
export function isAdvancedSearchReady(config: AdvancedSearchConfig | null | undefined): boolean {
  if (!config) return false;
  if (!config.baseUrl?.trim() || !config.apiKey?.trim()) return false;
  if (config.protocol === "custom" && !config.mapping) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 自定义协议：从响应示例推断结果映射
// ---------------------------------------------------------------------------

const URL_KEYS = ["url", "link", "href"];
const TITLE_KEYS = ["title", "name"];
const SNIPPET_KEYS = ["snippet", "summary", "content", "description", "desc", "abstract", "text"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 在对象的自有键里按候选名做大小写不敏感匹配，返回实际键名；requireHttp 时要求值是 http(s) 字符串 */
function findKey(obj: Record<string, unknown>, candidates: string[], requireHttp = false): string | null {
  for (const [key, value] of Object.entries(obj)) {
    if (!candidates.includes(key.toLowerCase())) continue;
    if (typeof value !== "string" && value != null) continue;
    if (requireHttp && (typeof value !== "string" || !/^https?:\/\//i.test(value))) continue;
    return key;
  }
  return null;
}

interface ArrayCandidate {
  path: string;
  arr: unknown[];
}

/** 收集 JSON 里所有「元素是对象」的数组及其点路径（深度限制防畸形输入） */
function collectArrays(node: unknown, path: string, out: ArrayCandidate[], depth: number): void {
  if (depth > 6 || node == null) return;
  if (Array.isArray(node)) {
    if (node.some(isPlainObject)) out.push({ path, arr: node });
    return;
  }
  if (isPlainObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      collectArrays(v, path ? `${path}.${k}` : k, out, depth + 1);
    }
  }
}

/**
 * 从用户粘贴的响应示例 JSON 推断结果映射。
 * 思路：找出所有「对象数组」节点，按 url(必须有，值需是 http 链接) + title + snippet 字段打分，
 * 取最高分。识别不出带 URL 的结果数组时返回 null（设置页据此提示示例不可用）。
 */
export function inferMapping(sample: string): AdvancedSearchMapping | null {
  let root: unknown;
  try {
    root = JSON.parse(sample);
  } catch {
    return null;
  }
  const candidates: ArrayCandidate[] = [];
  if (Array.isArray(root)) {
    if (root.some(isPlainObject)) candidates.push({ path: "", arr: root });
  } else {
    collectArrays(root, "", candidates, 0);
  }

  let best: { score: number; mapping: AdvancedSearchMapping } | null = null;
  for (const { path, arr } of candidates) {
    // 合并前几个对象的键做判断（单个对象可能缺字段）
    const merged: Record<string, unknown> = {};
    for (const el of arr.slice(0, 3)) {
      if (isPlainObject(el)) Object.assign(merged, el);
    }
    const urlField = findKey(merged, URL_KEYS, true);
    if (!urlField) continue;
    const titleField = findKey(merged, TITLE_KEYS);
    const snippetField = findKey(merged, SNIPPET_KEYS);
    const score = 2 + (titleField ? 1 : 0) + (snippetField ? 1 : 0);
    if (!best || score > best.score) {
      best = {
        score,
        mapping: {
          resultsPath: path,
          titleField: titleField ?? "",
          urlField,
          snippetField: snippetField ?? "",
        },
      };
    }
  }
  return best?.mapping ?? null;
}

/** 按 mapping 从真实响应里提取结果（导出供单测） */
export function applyMapping(json: unknown, mapping: AdvancedSearchMapping, limit: number): SearchResult[] {
  let node: unknown = json;
  if (mapping.resultsPath) {
    for (const seg of mapping.resultsPath.split(".")) {
      if (!isPlainObject(node)) return [];
      node = node[seg];
    }
  }
  if (!Array.isArray(node)) return [];
  const results: SearchResult[] = [];
  for (const el of node) {
    if (!isPlainObject(el)) continue;
    const url = typeof el[mapping.urlField] === "string" ? (el[mapping.urlField] as string) : "";
    if (!/^https?:\/\//i.test(url)) continue;
    const title = typeof el[mapping.titleField] === "string" ? (el[mapping.titleField] as string) : "";
    const snippet = typeof el[mapping.snippetField] === "string" ? (el[mapping.snippetField] as string) : "";
    results.push({ title: title || url, url, snippet });
    if (results.length >= limit) break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// 请求构建与响应解析
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** 各协议的请求体字段约定（请求侧统一 POST JSON + Bearer） */
function buildBody(config: AdvancedSearchConfig, query: string, numResults: number): Record<string, unknown> {
  switch (config.protocol) {
    case "tavily":
      return { query, max_results: numResults };
    case "bocha":
      // count 上限 50；summary:true 让每页带长摘要；freshness 按官方推荐 noLimit
      return { query, count: clamp(numResults, 1, 50), summary: true, freshness: "noLimit" };
    case "custom":
      return { query, count: numResults };
  }
}

/** 解析响应为统一结果列表；业务错误（如博查 code != 200）抛 Error（导出供单测） */
export function parseSearchResponse(config: AdvancedSearchConfig, json: unknown, limit: number): SearchResult[] {
  switch (config.protocol) {
    case "tavily": {
      const arr = isPlainObject(json) && Array.isArray(json.results) ? json.results : [];
      const results: SearchResult[] = [];
      for (const el of arr) {
        if (!isPlainObject(el)) continue;
        const url = typeof el.url === "string" ? el.url : "";
        if (!/^https?:\/\//i.test(url)) continue;
        results.push({
          title: typeof el.title === "string" && el.title ? el.title : url,
          url,
          snippet: typeof el.content === "string" ? el.content : "",
        });
        if (results.length >= limit) break;
      }
      return results;
    }
    case "bocha": {
      // 博查业务码：code !== 200 即失败（如 403 余额不足），msg 带原因
      if (isPlainObject(json) && typeof json.code === "number" && json.code !== 200) {
        throw new Error(typeof json.msg === "string" && json.msg ? json.msg : `Bocha 返回错误码 ${json.code}`);
      }
      const webPages = isPlainObject(json) && isPlainObject(json.data) ? json.data.webPages : null;
      const arr = isPlainObject(webPages) && Array.isArray(webPages.value) ? webPages.value : [];
      const results: SearchResult[] = [];
      for (const el of arr) {
        if (!isPlainObject(el)) continue;
        const url = typeof el.url === "string" ? el.url : "";
        if (!/^https?:\/\//i.test(url)) continue;
        // 请求时开了 summary:true；缺 summary 的条目退回 snippet
        const snippet =
          typeof el.summary === "string" && el.summary ? el.summary : typeof el.snippet === "string" ? el.snippet : "";
        results.push({
          title: typeof el.name === "string" && el.name ? el.name : url,
          url,
          snippet,
        });
        if (results.length >= limit) break;
      }
      return results;
    }
    case "custom": {
      if (!config.mapping) throw new Error("自定义协议缺少响应映射（请在设置页粘贴响应示例并保存）");
      return applyMapping(json, config.mapping, limit);
    }
  }
}

/**
 * 执行一次高级搜索。抛 Error 表示失败（HTTP 错误 / 业务错误 / 网络错误），
 * 调用方（工具 / 测试连接 IPC）决定怎么呈现；超时与外部 abort 都会中止请求。
 */
export async function executeSearch(
  config: AdvancedSearchConfig,
  query: string,
  numResults: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
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
      body: JSON.stringify(buildBody(config, query, numResults)),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: unknown = await res.json();
    return parseSearchResponse(config, json, numResults);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
