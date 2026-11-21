/**
 * 图像生成：同步 HTTP JSON 协议适配层。
 *
 * 内置仅保留千问AI平台「同步图像生成」：
 * POST /api/v1/services/aigc/multimodal-generation/generation
 * 文档：https://platform.qianwenai.com/docs/api-reference/image-generation/qwen-text-to-image
 *
 * 自定义协议由用户提供完整请求 Body JSON 模板与图片响应路径，不猜测响应结构。
 * 模板先按 JSON 解析，再递归替换占位符，因此提示词中的引号、换行不会破坏请求体。
 * 图片值支持 http(s) URL、data URL 与原始 base64；URL 会立即下载，避免临时链接过期。
 *
 * shared 包同时服务主进程「测试生成」、agent-host 的 GenerateImage 工具和设置页校验。
 */
import type { ImageGenConfig, ImageGenProtocol, QwenImageGenBilling } from "./index.js";

export const QWEN_IMAGE_GEN_ENDPOINT =
  "https://maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation";
export const QWEN_TOKEN_PLAN_IMAGE_GEN_ENDPOINT =
  "https://token-plan.maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation";
export const QWEN_IMAGE_GEN_ENDPOINTS: Record<QwenImageGenBilling, string> = {
  payg: QWEN_IMAGE_GEN_ENDPOINT,
  "token-plan": QWEN_TOKEN_PLAN_IMAGE_GEN_ENDPOINT,
};
export const QWEN_IMAGE_RESPONSE_PATH = "output.choices[*].message.content[*].image";

/** 自定义表单的初始模板，只是可编辑起点，不属于额外内置协议。 */
export const DEFAULT_CUSTOM_IMAGE_GEN_BODY = `{
  "model": "{{model}}",
  "prompt": "{{prompt}}",
  "size": "{{size}}",
  "n": 1
}`;

export const IMAGE_GEN_PRESETS: Record<
  ImageGenProtocol,
  { baseUrl: string; model: string; requestBody: string; responsePath: string }
> = {
  qwen: { baseUrl: QWEN_IMAGE_GEN_ENDPOINT, model: "", requestBody: "", responsePath: QWEN_IMAGE_RESPONSE_PATH },
  custom: {
    baseUrl: "",
    model: "",
    requestBody: DEFAULT_CUSTOM_IMAGE_GEN_BODY,
    responsePath: "data[0].b64_json",
  },
};

/** 旧配置没有 billing 时按已保存的官方端点识别；未知/自定义地址保持按量付费兼容行为。 */
export function inferQwenImageGenBilling(baseUrl?: string): QwenImageGenBilling {
  return baseUrl?.trim() === QWEN_TOKEN_PLAN_IMAGE_GEN_ENDPOINT ? "token-plan" : "payg";
}

/** 千问内置协议的计费方式是端点权威来源，避免 sk-sp- 密钥误发到按量付费 host。 */
export function resolveQwenImageGenEndpoint(config: ImageGenConfig): string {
  return config.billing ? QWEN_IMAGE_GEN_ENDPOINTS[config.billing] : config.baseUrl;
}

export type ImageGenRequestBodyError = "empty" | "invalidJson" | "notObject" | "missingPrompt";

/** 配置是否完整到可以生效（session-controller 据此决定 GenerateImage 是否进活跃工具集） */
export function isImageGenReady(config: ImageGenConfig | null | undefined): boolean {
  if (!config) return false;
  if (!config.protocol || !config.baseUrl?.trim() || !config.apiKey?.trim() || !config.model?.trim()) return false;
  if (config.protocol === "qwen") {
    return config.billing === undefined || Object.hasOwn(QWEN_IMAGE_GEN_ENDPOINTS, config.billing);
  }
  if (config.protocol !== "custom") return false;
  return (
    validateImageGenRequestBody(config.requestBody ?? "") === null &&
    isValidImageGenResponsePath(config.responsePath ?? "")
  );
}

/** 字段级 sanitize（fail-safe）：旧协议、非法自定义配置或缺字段直接判 null，绝不带病合并进设置 */
export function sanitizeImageGenConfig(input: unknown): ImageGenConfig | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const src = input as Partial<ImageGenConfig>;
  const protocol = src.protocol;
  if (protocol !== "qwen" && protocol !== "custom") return null;
  if (typeof src.baseUrl !== "string" || typeof src.apiKey !== "string" || typeof src.model !== "string") return null;
  const base = { protocol, baseUrl: src.baseUrl, apiKey: src.apiKey, model: src.model };
  if (protocol === "qwen") {
    const billing = src.billing ?? inferQwenImageGenBilling(src.baseUrl);
    if (!Object.hasOwn(QWEN_IMAGE_GEN_ENDPOINTS, billing)) return null;
    return { ...base, billing };
  }
  if (typeof src.requestBody !== "string" || typeof src.responsePath !== "string") return null;
  return { ...base, requestBody: src.requestBody, responsePath: src.responsePath };
}

export interface ImageGenOptions {
  /** 期望尺寸（如 1024x1024）；千问请求中转换为官方要求的 宽*高 */
  size?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface GeneratedImage {
  mimeType: string;
  /** base64 编码的位图字节 */
  data: string;
}

export interface ImageGenOutcome {
  images: GeneratedImage[];
  /** 模型随图返回的文本（修订后的 prompt / 说明），可能为空 */
  text: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;
/** 下载 url 形态图片的大小上限（防畸形响应把内存吃光） */
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 公共工具
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 从 base64 头部魔数嗅探位图类型（响应不带 mimeType 时的兜底） */
export function sniffImageMime(base64: string): string {
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  if (base64.startsWith("UklGR")) return "image/webp";
  if (base64.startsWith("Qk0")) return "image/bmp";
  return "image/png";
}

const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i;

/** data URL → 位图；非 data URL 返回 null */
export function parseDataUrl(url: string): GeneratedImage | null {
  const m = DATA_URL_RE.exec(url.trim());
  if (!m) return null;
  const data = (m[2] ?? "").replace(/\s+/g, "");
  if (!data) return null;
  return { mimeType: (m[1] ?? "image/png").toLowerCase(), data };
}

/** 提取服务端错误原文（{error:{message}} 或 {message}），截断防刷屏 */
async function extractErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text.trim()) return "";
    try {
      const json: unknown = JSON.parse(text);
      const root = Array.isArray(json) ? json[0] : json;
      if (isPlainObject(root)) {
        const err = root.error;
        if (isPlainObject(err) && typeof err.message === "string") return `: ${err.message.slice(0, 300)}`;
        if (typeof root.message === "string") return `: ${root.message.slice(0, 300)}`;
      }
    } catch {
      // 非 JSON 错误体：原样截断
    }
    return `: ${text.slice(0, 300)}`;
  } catch {
    return "";
  }
}

/** 下载 http(s) 图片，校验类型与大小 */
async function downloadImage(url: string, signal: AbortSignal): Promise<GeneratedImage> {
  const res = await fetch(url, { redirect: "follow", signal });
  if (!res.ok) throw new Error(`Image download failed (HTTP ${res.status})`);
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) throw new Error("Image download failed: empty response");
  if (buf.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("Image download failed: exceeds 25MB limit");
  const data = buf.toString("base64");
  const mimeType = contentType.startsWith("image/") ? contentType : sniffImageMime(data);
  return { mimeType, data };
}

/** 响应图片字段可以是 data URL、临时 URL 或原始 base64。 */
async function resolveImageValue(value: string, signal: AbortSignal): Promise<GeneratedImage | null> {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const inline = parseDataUrl(trimmed);
  if (inline) return inline;
  if (/^https?:\/\//i.test(trimmed)) return downloadImage(trimmed, signal);
  const data = trimmed.replace(/\s+/g, "");
  if (data.length < 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  // 无 MIME 的原始 base64 必须能嗅探出真实位图魔数，避免把普通文本当 PNG 落盘。
  if (!/^(iVBOR|\/9j\/|R0lGOD|UklGR|Qk0)/.test(data)) return null;
  return { mimeType: sniffImageMime(data), data };
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}${await extractErrorDetail(res)}`);
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// 请求 Body 模板：先 parse JSON，再替换值，保证任意提示词都安全序列化
// ---------------------------------------------------------------------------

interface TemplateValues {
  prompt: string;
  model: string;
  apiKey: string;
  size: string;
  width: number;
  height: number;
  n: number;
}

function parseSize(size?: string): { size: string; width: number; height: number } {
  const normalized = size?.trim() || "1024x1024";
  const match = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(normalized);
  return match
    ? { size: normalized, width: Number(match[1]), height: Number(match[2]) }
    : { size: normalized, width: 1024, height: 1024 };
}

function substituteTemplate(node: unknown, values: TemplateValues): unknown {
  if (typeof node === "string") {
    const exact = /^\{\{(prompt|model|apiKey|size|width|height|n)\}\}$/.exec(node.trim());
    if (exact) return values[exact[1] as keyof TemplateValues];
    return node.replace(/\{\{(prompt|model|apiKey|size|width|height|n)\}\}/g, (_all, key: keyof TemplateValues) =>
      String(values[key]),
    );
  }
  if (Array.isArray(node)) return node.map((item) => substituteTemplate(item, values));
  if (isPlainObject(node)) {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, substituteTemplate(value, values)]));
  }
  return node;
}

/** 返回可直接映射到设置页文案的错误码；null 表示模板有效。 */
export function validateImageGenRequestBody(template: string): ImageGenRequestBodyError | null {
  if (!template.trim()) return "empty";
  let parsed: unknown;
  try {
    parsed = JSON.parse(template);
  } catch {
    return "invalidJson";
  }
  if (!isPlainObject(parsed)) return "notObject";
  return template.includes("{{prompt}}") ? null : "missingPrompt";
}

export function buildCustomImageGenBody(
  config: ImageGenConfig,
  prompt: string,
  size?: string,
): Record<string, unknown> {
  const error = validateImageGenRequestBody(config.requestBody ?? "");
  if (error) throw new Error(`Invalid custom image request body: ${error}`);
  const parsed = JSON.parse(config.requestBody as string) as Record<string, unknown>;
  const dimensions = parseSize(size);
  return substituteTemplate(parsed, {
    prompt,
    model: config.model,
    apiKey: config.apiKey,
    ...dimensions,
    n: 1,
  }) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 响应路径：点号属性 + [0] 下标 + [*] 通配，支持单图与多图
// ---------------------------------------------------------------------------

type ResponsePathToken = { kind: "key"; key: string } | { kind: "index"; index: number } | { kind: "all" };

function parseResponsePath(path: string): ResponsePathToken[] | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const tokens: ResponsePathToken[] = [];
  for (const segment of trimmed.split(".")) {
    const match = /^([^[\]]+)((?:\[(?:\d+|\*)\])*)$/.exec(segment);
    if (!match) return null;
    tokens.push({ kind: "key", key: match[1] as string });
    for (const suffix of (match[2] ?? "").matchAll(/\[(\d+|\*)\]/g)) {
      const value = suffix[1] as string;
      tokens.push(value === "*" ? { kind: "all" } : { kind: "index", index: Number(value) });
    }
  }
  return tokens.length ? tokens : null;
}

export function isValidImageGenResponsePath(path: string): boolean {
  return parseResponsePath(path) !== null;
}

function responseValues(json: unknown, path: string): unknown[] {
  const tokens = parseResponsePath(path);
  if (!tokens) return [];
  let nodes: unknown[] = [json];
  for (const token of tokens) {
    const next: unknown[] = [];
    for (const node of nodes) {
      if (token.kind === "key") {
        if (isPlainObject(node) && Object.hasOwn(node, token.key)) next.push(node[token.key]);
      } else if (token.kind === "index") {
        if (Array.isArray(node) && token.index < node.length) next.push(node[token.index]);
      } else if (Array.isArray(node)) {
        next.push(...node);
      }
    }
    nodes = next;
    if (nodes.length === 0) break;
  }
  // 路径直接指向字符串数组时也合法，无需强制写 [*]。
  return nodes.flatMap((node) => (Array.isArray(node) ? node : [node]));
}

function responseErrorHint(json: unknown): string {
  if (!isPlainObject(json)) return "";
  if (typeof json.message === "string") return `: ${json.message.slice(0, 200)}`;
  if (isPlainObject(json.error) && typeof json.error.message === "string") {
    return `: ${json.error.message.slice(0, 200)}`;
  }
  return "";
}

async function parseResponseByPath(
  json: unknown,
  imagePath: string,
  signal: AbortSignal,
  textPath?: string,
): Promise<ImageGenOutcome> {
  if (!isValidImageGenResponsePath(imagePath)) throw new Error("Invalid image response path");
  const rawImages = responseValues(json, imagePath).filter(
    (value): value is string => typeof value === "string" && !!value.trim(),
  );
  if (rawImages.length === 0) {
    throw new Error(`Response contained no image at ${imagePath}${responseErrorHint(json)}`);
  }
  const resolved = await Promise.all(rawImages.map((value) => resolveImageValue(value, signal)));
  const images = resolved.filter((image): image is GeneratedImage => image !== null);
  if (images.length === 0) throw new Error(`Response image field is not a URL, data URL or base64: ${imagePath}`);
  const text = textPath
    ? responseValues(json, textPath)
        .filter((value): value is string => typeof value === "string" && !!value.trim())
        .join("\n")
        .trim()
    : "";
  return { images, text };
}

// ---------------------------------------------------------------------------
// 千问AI平台同步图像生成
// ---------------------------------------------------------------------------

export function sizeToQwenSize(size?: string): string | null {
  const trimmed = size?.trim();
  if (!trimmed) return null;
  const match = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(trimmed);
  return match ? `${match[1]}*${match[2]}` : null;
}

export function buildQwenImageGenBody(config: ImageGenConfig, prompt: string, size?: string): Record<string, unknown> {
  const parameters: Record<string, unknown> = {
    n: 1,
    prompt_extend: true,
    watermark: false,
    response_format: "url",
  };
  const qwenSize = sizeToQwenSize(size);
  if (qwenSize) parameters.size = qwenSize;
  return {
    model: config.model,
    input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
    parameters,
  };
}

export function parseQwenImageGenResponse(json: unknown, signal: AbortSignal): Promise<ImageGenOutcome> {
  return parseResponseByPath(json, QWEN_IMAGE_RESPONSE_PATH, signal, "output.choices[*].message.content[*].text");
}

export function parseCustomImageGenResponse(
  json: unknown,
  responsePath: string,
  signal: AbortSignal,
): Promise<ImageGenOutcome> {
  return parseResponseByPath(json, responsePath, signal);
}

// ---------------------------------------------------------------------------
// 统一入口：所有协议均为一次同步 POST，不创建或轮询异步任务。
// ---------------------------------------------------------------------------

export async function executeImageGen(
  config: ImageGenConfig,
  prompt: string,
  opts: ImageGenOptions = {},
): Promise<ImageGenOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort);
  try {
    if (config.protocol === "qwen") {
      const json = await postJson(
        resolveQwenImageGenEndpoint(config),
        { Authorization: `Bearer ${config.apiKey}` },
        buildQwenImageGenBody(config, prompt, opts.size),
        controller.signal,
      );
      return await parseQwenImageGenResponse(json, controller.signal);
    }
    if (config.protocol === "custom") {
      const json = await postJson(
        config.baseUrl,
        { Authorization: `Bearer ${config.apiKey}` },
        buildCustomImageGenBody(config, prompt, opts.size),
        controller.signal,
      );
      return await parseCustomImageGenResponse(json, config.responsePath ?? "", controller.signal);
    }
    throw new Error(`Unsupported image generation protocol: ${String(config.protocol)}`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
