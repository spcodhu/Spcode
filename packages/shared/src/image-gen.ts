/**
 * 图像生成：协议适配层（OpenAI Images / OpenAI 兼容 Chat / Gemini 原生）。
 *
 * 放在 shared 包里是因为三处都要用：
 * - 主进程：「测试生成」IPC 发真实请求（executeImageGen）；
 * - agent-host：GenerateImage 工具执行（executeImageGen）；
 * - 渲染进程设置页：isImageGenReady 判定配置状态、预设端点自动填充。
 *
 * 请求侧统一约定：POST JSON；OpenAI 系走 Bearer 鉴权，Gemini 走 x-goog-api-key。
 * 响应侧：三种协议各自解析出 base64 位图（url 形态会代为下载），失败抛出带服务端原文的错误。
 */
import type { ImageGenConfig, ImageGenProtocol } from "./index.js";

/** 预设协议的默认端点与模型（设置页切换预设时自动填充） */
export const IMAGE_GEN_PRESETS: Record<ImageGenProtocol, { baseUrl: string; model: string }> = {
  "openai-images": { baseUrl: "https://api.openai.com/v1/images/generations", model: "gpt-image-1" },
  "openai-chat": { baseUrl: "https://api.openai.com/v1/chat/completions", model: "gemini-2.5-flash-image" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash-image" },
};

/** 配置是否完整到可以生效（session-controller 据此决定 GenerateImage 是否进活跃工具集） */
export function isImageGenReady(config: ImageGenConfig | null | undefined): boolean {
  if (!config) return false;
  return !!(config.protocol && config.baseUrl?.trim() && config.apiKey?.trim() && config.model?.trim());
}

/** 字段级 sanitize（fail-safe）：非法协议/缺字段直接判 null，绝不带病合并进设置 */
export function sanitizeImageGenConfig(input: unknown): ImageGenConfig | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const src = input as Partial<ImageGenConfig>;
  const protocol = src.protocol;
  if (protocol !== "openai-images" && protocol !== "openai-chat" && protocol !== "gemini") return null;
  if (typeof src.baseUrl !== "string" || typeof src.apiKey !== "string" || typeof src.model !== "string") return null;
  return { protocol, baseUrl: src.baseUrl, apiKey: src.apiKey, model: src.model };
}

export interface ImageGenOptions {
  /** 期望尺寸（如 1024x1024 / 1536x1024 / 1024x1536）；协议不支持时忽略或映射为宽高比 */
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

const DEFAULT_TIMEOUT_MS = 120_000;
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

/** 提取服务端错误原文（OpenAI {error:{message}} / Gemini 同构或数组包裹），截断防刷屏 */
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

/** 下载 http(s) 图片（dall-e 的 url 形态 / chat 响应里的外链图），校验类型与大小 */
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

/** 任意形态的 url 字段（data URL / http 外链）→ 位图 */
async function resolveImageUrl(url: string, signal: AbortSignal): Promise<GeneratedImage | null> {
  const inline = parseDataUrl(url);
  if (inline) return inline;
  if (/^https?:\/\//i.test(url.trim())) return downloadImage(url.trim(), signal);
  return null;
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
// 协议一：OpenAI Images API（POST /v1/images/generations）
// ---------------------------------------------------------------------------

/** gpt-image 系列恒返 b64_json 且拒绝 response_format 参数；dall-e 等需要显式声明 */
function buildImagesBody(config: ImageGenConfig, prompt: string, size?: string): Record<string, unknown> {
  const body: Record<string, unknown> = { model: config.model, prompt, n: 1 };
  if (size?.trim()) body.size = size.trim();
  if (!/^gpt-image/i.test(config.model)) body.response_format = "b64_json";
  return body;
}

export async function parseImagesResponse(json: unknown, signal: AbortSignal): Promise<ImageGenOutcome> {
  if (!isPlainObject(json) || !Array.isArray(json.data)) throw new Error("Unexpected response: missing data array");
  const images: GeneratedImage[] = [];
  let text = "";
  for (const item of json.data) {
    if (!isPlainObject(item)) continue;
    if (typeof item.revised_prompt === "string" && item.revised_prompt.trim()) text = item.revised_prompt;
    if (typeof item.b64_json === "string" && item.b64_json) {
      images.push({ mimeType: sniffImageMime(item.b64_json), data: item.b64_json });
    } else if (typeof item.url === "string" && item.url) {
      const img = await resolveImageUrl(item.url, signal);
      if (img) images.push(img);
    }
  }
  if (images.length === 0) throw new Error("Response contained no image data");
  return { images, text };
}

// ---------------------------------------------------------------------------
// 协议二：OpenAI 兼容 Chat Completions（中转/订阅套餐常见的生图路由）
// ---------------------------------------------------------------------------

/** Markdown 内嵌图：![alt](data:… 或 https://…) */
const MD_IMAGE_RE = /!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g;

export async function parseChatResponse(json: unknown, signal: AbortSignal): Promise<ImageGenOutcome> {
  if (!isPlainObject(json) || !Array.isArray(json.choices))
    throw new Error("Unexpected response: missing choices array");
  const choice = json.choices[0];
  const message = isPlainObject(choice) ? choice.message : undefined;
  if (!isPlainObject(message)) throw new Error("Unexpected response: missing message");

  const images: GeneratedImage[] = [];
  const textParts: string[] = [];
  const pushUrl = async (url: unknown) => {
    if (typeof url !== "string" || !url) return;
    const img = await resolveImageUrl(url, signal);
    if (img) images.push(img);
  };

  // 形态一：message.images（OpenRouter 风格）[{ image_url: { url } }]
  if (Array.isArray(message.images)) {
    for (const item of message.images) {
      if (isPlainObject(item)) {
        const imageUrl = item.image_url;
        await pushUrl(isPlainObject(imageUrl) ? imageUrl.url : item.url);
      }
    }
  }

  // 形态二：content 为分块数组 [{ type: "image_url" | "text", … }]
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isPlainObject(part)) continue;
      if (part.type === "image_url") {
        const imageUrl = part.image_url;
        await pushUrl(isPlainObject(imageUrl) ? imageUrl.url : undefined);
      } else if (part.type === "text" && typeof part.text === "string") {
        textParts.push(part.text);
      }
    }
  } else if (typeof message.content === "string") {
    // 形态三：content 为字符串，图片以 Markdown 内嵌（data URL 或外链）
    let content = message.content;
    for (const m of content.matchAll(MD_IMAGE_RE)) {
      await pushUrl(m[1]);
    }
    content = content.replace(MD_IMAGE_RE, "").trim();
    if (content) textParts.push(content);
  }

  if (images.length === 0) {
    const hint = textParts.join(" ").slice(0, 200);
    throw new Error(`Model returned no image (it may not support image output)${hint ? `: ${hint}` : ""}`);
  }
  return { images, text: textParts.join("\n").trim() };
}

// ---------------------------------------------------------------------------
// 协议三：Gemini 原生 generateContent
// ---------------------------------------------------------------------------

/** 尺寸 → Gemini 宽高比（取最接近的官方档位）；无法识别时返回 null */
export function sizeToAspectRatio(size?: string): string | null {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size?.trim() ?? "");
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h) return null;
  const ratio = w / h;
  const candidates: [string, number][] = [
    ["1:1", 1],
    ["3:2", 1.5],
    ["2:3", 2 / 3],
    ["4:3", 4 / 3],
    ["3:4", 0.75],
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["4:5", 0.8],
    ["5:4", 1.25],
    ["21:9", 21 / 9],
  ];
  let best: [string, number] = ["1:1", 1];
  for (const c of candidates) {
    if (Math.abs(Math.log(ratio / c[1])) < Math.abs(Math.log(ratio / best[1]))) best = c;
  }
  return best[0];
}

function buildGeminiBody(prompt: string, model: string, size?: string): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = { responseModalities: ["TEXT", "IMAGE"] };
  // imageConfig 仅 gemini-3 系列图像模型支持；flash-image 传了会报错
  const aspectRatio = sizeToAspectRatio(size);
  if (aspectRatio && /gemini-3/i.test(model)) generationConfig.imageConfig = { aspectRatio };
  return { contents: [{ parts: [{ text: prompt }] }], generationConfig };
}

export function parseGeminiResponse(json: unknown): ImageGenOutcome {
  if (!isPlainObject(json)) throw new Error("Unexpected response from Gemini");
  const feedback = json.promptFeedback;
  if (isPlainObject(feedback) && typeof feedback.blockReason === "string" && feedback.blockReason) {
    throw new Error(`Prompt blocked by Gemini: ${feedback.blockReason}`);
  }
  const candidates = json.candidates;
  const first = Array.isArray(candidates) ? candidates[0] : undefined;
  const content = isPlainObject(first) ? first.content : undefined;
  const parts = isPlainObject(content) && Array.isArray(content.parts) ? content.parts : [];
  const images: GeneratedImage[] = [];
  const textParts: string[] = [];
  for (const part of parts) {
    if (!isPlainObject(part)) continue;
    const inline = part.inlineData;
    if (isPlainObject(inline) && typeof inline.data === "string" && inline.data) {
      const mimeType =
        typeof inline.mimeType === "string" && inline.mimeType ? inline.mimeType : sniffImageMime(inline.data);
      images.push({ mimeType, data: inline.data });
    } else if (typeof part.text === "string" && part.text.trim()) {
      textParts.push(part.text);
    }
  }
  if (images.length === 0) {
    const finish = isPlainObject(first) ? first.finishReason : undefined;
    const hint = textParts.join(" ").slice(0, 200);
    throw new Error(
      `Gemini returned no image${typeof finish === "string" ? ` (finishReason: ${finish})` : ""}${hint ? `: ${hint}` : ""}`,
    );
  }
  return { images, text: textParts.join("\n").trim() };
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

/**
 * 执行一次生图。超时与中断合并进同一个 AbortController（与 executeSearch 同口径）。
 * 失败抛出 Error（message 含服务端原文），由调用方决定展示形态。
 */
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
    if (config.protocol === "openai-images") {
      const json = await postJson(
        config.baseUrl,
        { Authorization: `Bearer ${config.apiKey}` },
        buildImagesBody(config, prompt, opts.size),
        controller.signal,
      );
      return await parseImagesResponse(json, controller.signal);
    }
    if (config.protocol === "openai-chat") {
      const json = await postJson(
        config.baseUrl,
        { Authorization: `Bearer ${config.apiKey}` },
        { model: config.model, messages: [{ role: "user", content: prompt }] },
        controller.signal,
      );
      return await parseChatResponse(json, controller.signal);
    }
    const base = config.baseUrl.replace(/\/+$/, "");
    const json = await postJson(
      `${base}/models/${encodeURIComponent(config.model)}:generateContent`,
      { "x-goog-api-key": config.apiKey },
      buildGeminiBody(prompt, config.model, opts.size),
      controller.signal,
    );
    return parseGeminiResponse(json);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
