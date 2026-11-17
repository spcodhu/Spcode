/**
 * 自定义供应商的按需模型发现。仅在协议存在标准列表接口时提供适配。
 * 凭证只在本模块所属的 agent-host 内使用；返回值不包含请求头或原始上游响应。
 */
import type { DiscoveredModel, ModelDiscoveryResult } from "@spcode/shared";
import { supportsModelDiscovery } from "@spcode/shared";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 20;
const MAX_MODELS = 2_000;

type FetchLike = typeof fetch;
type Headers = Record<string, string | null | undefined>;

export interface DiscoverModelsInput {
  provider: string;
  api: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Headers;
}

interface DiscoveryState {
  models: DiscoveredModel[];
  truncated?: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const expected = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === expected && !!headers[key]);
}

function requestHeaders(input: DiscoverModelsInput): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (typeof value === "string" && value) headers[key] = value;
  }
  if (input.api === "anthropic-messages") {
    if (input.apiKey && !hasHeader(headers, "x-api-key") && !hasHeader(headers, "authorization")) {
      headers["x-api-key"] = input.apiKey;
    }
    if (!hasHeader(headers, "anthropic-version")) headers["anthropic-version"] = "2023-06-01";
  } else if (input.api === "google-generative-ai") {
    if (input.apiKey && !hasHeader(headers, "x-goog-api-key")) headers["x-goog-api-key"] = input.apiKey;
  } else if (input.apiKey && !hasHeader(headers, "authorization")) {
    headers.authorization = `Bearer ${input.apiKey}`;
  }
  return headers;
}

function secretValues(input: DiscoverModelsInput): string[] {
  const secrets = input.apiKey ? [input.apiKey] : [];
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (value && /authorization|api[-_]?key|token/i.test(key)) secrets.push(value);
  }
  return secrets.filter((value) => value.length >= 3);
}

function redact(value: string, secrets: readonly string[]): string {
  let next = value;
  for (const secret of secrets) next = next.split(secret).join("[redacted]");
  return next.slice(0, 500);
}

function endpoint(baseUrl: string, suffix: "models" | "v1/models"): URL {
  const url = new URL(baseUrl);
  if (url.username || url.password || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error("models.providerInvalidBaseUrl");
  }
  const basePath = url.pathname.replace(/\/+$/u, "");
  // Anthropic/Mistral 的标准地址不带 /v1，但用户也可能把 /v1 填进 Base URL；
  // 这里统一避免 /v1/v1/models，同时保留 OpenAI 根地址的 /models 形态。
  const normalizedSuffix = suffix.startsWith("v1/") && /(?:^|\/)v1$/u.test(basePath) ? suffix.slice(3) : suffix;
  url.pathname = `${basePath}/${normalizedSuffix}`;
  url.search = "";
  url.hash = "";
  return url;
}

async function readBodyLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("models.discoveryResponseTooLarge");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("models.discoveryResponseTooLarge");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function upstreamDetail(body: string): string {
  try {
    const parsed = record(JSON.parse(body));
    const error = record(parsed?.error);
    return text(error?.message) ?? text(parsed?.message) ?? text(parsed?.message_zh) ?? "";
  } catch {
    return body.trim();
  }
}

async function requestJson(
  url: URL,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
  secrets: readonly string[],
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(redact(error instanceof Error ? error.message : String(error), secrets));
  }
  if (response.status >= 300 && response.status < 400) throw new Error("models.discoveryRedirect");
  const body = await readBodyLimited(response);
  if (!response.ok) {
    const detail = redact(upstreamDetail(body), secrets);
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("models.discoveryInvalidJson");
  }
}

function inactive(status: string | undefined): boolean {
  const normalized = status?.toLowerCase();
  return normalized === "offline" || normalized === "retired" || normalized === "disabled";
}

function normalizeOpenAi(payload: unknown): DiscoveredModel[] {
  const data = record(payload)?.data;
  if (!Array.isArray(data)) throw new Error("models.discoveryInvalidResponse");
  const models: DiscoveredModel[] = [];
  for (const raw of data) {
    const item = record(raw);
    const id = text(item?.id);
    if (!item || !id) continue;
    const status = text(item.status);
    const shutdownAt = text(item.shutdown_date);
    if (inactive(status) || (shutdownAt && Date.parse(shutdownAt) <= Date.now())) continue;
    models.push({
      id,
      displayName: text(item.name) ?? id,
      status: status ?? (shutdownAt ? "pre-offline" : undefined),
    });
  }
  return models;
}

function normalizeMistral(payload: unknown): DiscoveredModel[] {
  const root = record(payload);
  const data = Array.isArray(payload) ? payload : root?.data;
  if (!Array.isArray(data)) throw new Error("models.discoveryInvalidResponse");
  const models: DiscoveredModel[] = [];
  for (const raw of data) {
    const item = record(raw);
    const id = text(item?.id);
    if (!item || !id) continue;
    const capabilities = record(item.capabilities);
    if (capabilities?.completion_chat === false || inactive(text(item.status))) continue;
    models.push({
      id,
      displayName: text(item.name) ?? id,
      status: text(item.status),
      contextWindow: positive(item.max_context_length),
      vision: bool(capabilities?.vision),
    });
  }
  return models;
}

async function discoverAnthropic(
  input: DiscoverModelsInput,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
  secrets: readonly string[],
): Promise<DiscoveryState> {
  const models: DiscoveredModel[] = [];
  let afterId: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = endpoint(input.baseUrl, "v1/models");
    url.searchParams.set("limit", "100");
    if (afterId) url.searchParams.set("after_id", afterId);
    const payload = record(await requestJson(url, headers, fetchImpl, secrets));
    const data = payload?.data;
    if (!Array.isArray(data)) throw new Error("models.discoveryInvalidResponse");
    for (const raw of data) {
      const item = record(raw);
      const id = text(item?.id);
      if (!item || !id) continue;
      const status = text(item.lifecycle);
      if (inactive(status)) continue;
      const capabilities = record(item.capabilities);
      models.push({
        id,
        displayName: text(item.display_name) ?? id,
        status,
        contextWindow: positive(item.max_input_tokens),
        maxTokens: positive(item.max_tokens),
        reasoning: bool(record(capabilities?.thinking)?.supported),
        vision: bool(record(capabilities?.image_input)?.supported),
      });
    }
    if (payload?.has_more !== true) return { models };
    const next = text(payload.last_id);
    if (!next || seenCursors.has(next)) return { models, truncated: true };
    seenCursors.add(next);
    afterId = next;
  }
  return { models, truncated: true };
}

async function discoverGoogle(
  input: DiscoverModelsInput,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
  secrets: readonly string[],
): Promise<DiscoveryState> {
  const models: DiscoveredModel[] = [];
  let pageToken: string | undefined;
  const seenTokens = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = endpoint(input.baseUrl, "models");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const payload = record(await requestJson(url, headers, fetchImpl, secrets));
    const data = payload?.models;
    if (!Array.isArray(data)) throw new Error("models.discoveryInvalidResponse");
    for (const raw of data) {
      const item = record(raw);
      const name = text(item?.name);
      if (!item || !name) continue;
      const methods = item.supportedGenerationMethods;
      if (Array.isArray(methods) && !methods.includes("generateContent")) continue;
      models.push({
        id: name.startsWith("models/") ? name.slice("models/".length) : name,
        displayName: text(item.displayName) ?? name,
        contextWindow: positive(item.inputTokenLimit),
        maxTokens: positive(item.outputTokenLimit),
      });
    }
    const next = text(payload?.nextPageToken);
    if (!next) return { models };
    if (seenTokens.has(next)) return { models, truncated: true };
    seenTokens.add(next);
    pageToken = next;
  }
  return { models, truncated: true };
}

export async function discoverModels(
  input: DiscoverModelsInput,
  fetchImpl: FetchLike = fetch,
): Promise<ModelDiscoveryResult> {
  if (!supportsModelDiscovery(input.api)) throw new Error("models.discoveryUnsupported");
  const headers = requestHeaders(input);
  const secrets = secretValues(input);
  let state: DiscoveryState;
  if (input.api === "anthropic-messages") {
    state = await discoverAnthropic(input, headers, fetchImpl, secrets);
  } else if (input.api === "google-generative-ai") {
    state = await discoverGoogle(input, headers, fetchImpl, secrets);
  } else {
    const url = endpoint(input.baseUrl, input.api === "mistral-conversations" ? "v1/models" : "models");
    const payload = await requestJson(url, headers, fetchImpl, secrets);
    state = {
      models: input.api === "mistral-conversations" ? normalizeMistral(payload) : normalizeOpenAi(payload),
    };
  }

  const byId = new Map<string, DiscoveredModel>();
  for (const model of state.models) if (!byId.has(model.id)) byId.set(model.id, model);
  const unique = [...byId.values()];
  const truncated = state.truncated || unique.length > MAX_MODELS || undefined;
  return {
    provider: input.provider,
    models: unique.slice(0, MAX_MODELS),
    ...(truncated ? { truncated, warnings: ["models.discoveryTruncated"] } : {}),
  };
}
