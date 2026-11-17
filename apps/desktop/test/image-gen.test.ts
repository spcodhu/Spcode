/**
 * 生图技能测试：协议适配（离线夹具 + mock fetch）、GenerateImage 工具落盘、配置 sanitize。
 * 真网连通性默认不跑（与 web-tools 同口径：SPCODE_TEST_NETWORK=1 显式开启）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageGenConfig } from "@spcode/shared";
import {
  executeImageGen,
  isImageGenReady,
  parseChatResponse,
  parseDataUrl,
  parseGeminiResponse,
  parseImagesResponse,
  sanitizeImageGenConfig,
  sizeToAspectRatio,
  sniffImageMime,
} from "@spcode/shared/image-gen";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createImageGenTool } from "../src/agent-host/tools/image-gen.js";

/** 1x1 透明 PNG（真实魔数，sniff/落盘断言用） */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const CONFIG: ImageGenConfig = {
  protocol: "openai-images",
  baseUrl: "https://api.example.com/v1/images/generations",
  apiKey: "sk-test",
  model: "gpt-image-1",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("sanitizeImageGenConfig / isImageGenReady", () => {
  it("合法配置原样保留", () => {
    expect(sanitizeImageGenConfig(CONFIG)).toEqual(CONFIG);
    expect(isImageGenReady(CONFIG)).toBe(true);
  });

  it("非法协议 / 缺字段 / 非对象一律判 null（未配置）", () => {
    expect(sanitizeImageGenConfig({ ...CONFIG, protocol: "midjourney" })).toBeNull();
    expect(sanitizeImageGenConfig({ ...CONFIG, apiKey: 123 })).toBeNull();
    expect(sanitizeImageGenConfig({ ...CONFIG, model: undefined })).toBeNull();
    expect(sanitizeImageGenConfig(null)).toBeNull();
    expect(sanitizeImageGenConfig([CONFIG])).toBeNull();
    expect(sanitizeImageGenConfig("x")).toBeNull();
  });

  it("空字段配置保留形状但不 ready（fail-safe：绝不带病生效）", () => {
    const empty = { ...CONFIG, apiKey: "  " };
    expect(sanitizeImageGenConfig(empty)).toEqual(empty);
    expect(isImageGenReady(empty)).toBe(false);
    expect(isImageGenReady(null)).toBe(false);
    expect(isImageGenReady(undefined)).toBe(false);
  });
});

describe("位图工具函数", () => {
  it("sniffImageMime 按魔数识别常见格式", () => {
    expect(sniffImageMime(PNG_B64)).toBe("image/png");
    expect(sniffImageMime("/9j/4AAQ")).toBe("image/jpeg");
    expect(sniffImageMime("R0lGODlh")).toBe("image/gif");
    expect(sniffImageMime("UklGRg")).toBe("image/webp");
  });

  it("parseDataUrl 解析 data URL，拒绝非位图/空数据", () => {
    expect(parseDataUrl(`data:image/png;base64,${PNG_B64}`)).toEqual({ mimeType: "image/png", data: PNG_B64 });
    expect(parseDataUrl("https://example.com/a.png")).toBeNull();
    expect(parseDataUrl("data:text/plain;base64,aGk=")).toBeNull();
    expect(parseDataUrl("data:image/png;base64,")).toBeNull();
  });

  it("sizeToAspectRatio 取最接近的官方档位", () => {
    expect(sizeToAspectRatio("1024x1024")).toBe("1:1");
    expect(sizeToAspectRatio("1536x1024")).toBe("3:2");
    expect(sizeToAspectRatio("1024x1536")).toBe("2:3");
    expect(sizeToAspectRatio("1920x1080")).toBe("16:9");
    expect(sizeToAspectRatio("auto")).toBeNull();
    expect(sizeToAspectRatio(undefined)).toBeNull();
  });
});

describe("parseImagesResponse（OpenAI Images）", () => {
  it("b64_json 直接转位图并嗅探类型", async () => {
    const out = await parseImagesResponse({ data: [{ b64_json: PNG_B64 }] }, new AbortController().signal);
    expect(out.images).toEqual([{ mimeType: "image/png", data: PNG_B64 }]);
  });

  it("revised_prompt 作为附注文本返回", async () => {
    const out = await parseImagesResponse(
      { data: [{ b64_json: PNG_B64, revised_prompt: "a red circle" }] },
      new AbortController().signal,
    );
    expect(out.text).toBe("a red circle");
  });

  it("url 形态代为下载（校验 content-type）", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(Buffer.from(PNG_B64, "base64"), { status: 200, headers: { "content-type": "image/png" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await parseImagesResponse(
      { data: [{ url: "https://cdn.example.com/x.png" }] },
      new AbortController().signal,
    );
    expect(out.images[0]?.mimeType).toBe("image/png");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cdn.example.com/x.png",
      expect.objectContaining({ redirect: "follow" }),
    );
  });

  it("缺 data 数组 / 空结果抛错", async () => {
    await expect(parseImagesResponse({}, new AbortController().signal)).rejects.toThrow(/missing data array/);
    await expect(parseImagesResponse({ data: [] }, new AbortController().signal)).rejects.toThrow(/no image data/);
  });
});

describe("executeImageGen：OpenAI Images 请求侧", () => {
  it("gpt-image 系列不带 response_format（该参数会被拒绝），Bearer 鉴权", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
    vi.stubGlobal("fetch", fetchMock);
    await executeImageGen(CONFIG, "a cat", { size: "1024x1024" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CONFIG.baseUrl);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ model: "gpt-image-1", prompt: "a cat", n: 1, size: "1024x1024" });
  });

  it("dall-e 等旧模型显式声明 response_format=b64_json", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
    vi.stubGlobal("fetch", fetchMock);
    await executeImageGen({ ...CONFIG, model: "dall-e-3" }, "a cat");
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.response_format).toBe("b64_json");
  });

  it("HTTP 错误带服务端原文", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "Invalid API key" } }, 401)),
    );
    await expect(executeImageGen(CONFIG, "a cat")).rejects.toThrow("HTTP 401: Invalid API key");
  });
});

describe("parseChatResponse（OpenAI 兼容 Chat 生图路由）", () => {
  const signal = new AbortController().signal;

  it("字符串 content 里的 Markdown 内嵌 data URL 图", async () => {
    const out = await parseChatResponse(
      { choices: [{ message: { content: `给你画好了：\n![cat](data:image/png;base64,${PNG_B64})\n希望喜欢` } }] },
      signal,
    );
    expect(out.images).toHaveLength(1);
    expect(out.text).toBe("给你画好了：\n\n希望喜欢");
  });

  it("content 分块数组（image_url + text）", async () => {
    const out = await parseChatResponse(
      {
        choices: [
          {
            message: {
              content: [
                { type: "text", text: "ok" },
                { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } },
              ],
            },
          },
        ],
      },
      signal,
    );
    expect(out.images).toHaveLength(1);
    expect(out.text).toBe("ok");
  });

  it("message.images（OpenRouter 风格）", async () => {
    const out = await parseChatResponse(
      { choices: [{ message: { content: "", images: [{ image_url: { url: `data:image/png;base64,${PNG_B64}` } }] } }] },
      signal,
    );
    expect(out.images).toHaveLength(1);
  });

  it("模型没回图时报错并附文本线索", async () => {
    await expect(
      parseChatResponse({ choices: [{ message: { content: "I cannot generate images." } }] }, signal),
    ).rejects.toThrow(/no image.*I cannot generate images/s);
  });
});

describe("parseGeminiResponse / Gemini 请求侧", () => {
  it("inlineData 转位图，text 部分作附注", () => {
    const out = parseGeminiResponse({
      candidates: [
        { content: { parts: [{ text: "here you go" }, { inlineData: { mimeType: "image/png", data: PNG_B64 } }] } },
      ],
    });
    expect(out.images).toEqual([{ mimeType: "image/png", data: PNG_B64 }]);
    expect(out.text).toBe("here you go");
  });

  it("prompt 被安全策略拦截时报 blockReason", () => {
    expect(() => parseGeminiResponse({ promptFeedback: { blockReason: "SAFETY" } })).toThrow(/blocked.*SAFETY/);
  });

  it("没图时带 finishReason 线索", () => {
    expect(() =>
      parseGeminiResponse({ candidates: [{ content: { parts: [{ text: "no" }] }, finishReason: "STOP" }] }),
    ).toThrow(/no image.*STOP/);
  });

  it("URL 拼 models/<model>:generateContent，x-goog-api-key 鉴权，flash 不带 imageConfig", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_B64 } }] } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await executeImageGen(
      {
        protocol: "gemini",
        baseUrl: "https://gen.example.com/v1beta/",
        apiKey: "g-key",
        model: "gemini-2.5-flash-image",
      },
      "a cat",
      { size: "1536x1024" },
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gen.example.com/v1beta/models/gemini-2.5-flash-image:generateContent");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-key");
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
    expect(body.generationConfig.imageConfig).toBeUndefined();
  });

  it("gemini-3 系列把尺寸映射成 imageConfig.aspectRatio", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_B64 } }] } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await executeImageGen(
      {
        protocol: "gemini",
        baseUrl: "https://gen.example.com/v1beta",
        apiKey: "g-key",
        model: "gemini-3-pro-image-preview",
      },
      "a cat",
      { size: "1536x1024" },
    );
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: "3:2" });
  });
});

describe("createImageGenTool（落盘与门控）", () => {
  let dir = "";

  function setup(getConfig: () => ImageGenConfig | null) {
    dir = mkdtempSync(join(tmpdir(), "spcode-image-gen-"));
    return createImageGenTool({ cwd: dir, getConfig });
  }

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exec = (tool: ReturnType<typeof createImageGenTool>, args: Record<string, unknown>) =>
    tool.execute("t1", args as any, undefined, undefined, {} as any) as Promise<{
      content: { type: string; text?: string }[];
      details?: { images?: { path: string; mimeType: string }[] };
      isError?: boolean;
    }>;

  it("未配置时报错并引导去设置页（不抛异常）", async () => {
    const tool = setup(() => null);
    const res = await exec(tool, { prompt: "a cat" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/Settings → Skills/);
  });

  it("空 prompt 报错", async () => {
    const tool = setup(() => CONFIG);
    const res = await exec(tool, { prompt: "  " });
    expect(res.isError).toBe(true);
  });

  it("成功：图片落盘 spcode-images/，details.images 带路径，正文含路径与免重复嵌入提示", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ b64_json: PNG_B64 }] })),
    );
    const tool = setup(() => CONFIG);
    const res = await exec(tool, { prompt: "a cat" });
    expect(res.isError).toBeFalsy();
    const images = res.details?.images ?? [];
    expect(images).toHaveLength(1);
    const path = images[0]?.path ?? "";
    expect(path).toContain(join(dir, "spcode-images"));
    expect(path.endsWith(".png")).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).toString("base64")).toBe(PNG_B64);
    const text = res.content[0]?.text ?? "";
    expect(text).toContain(path);
    expect(text).toMatch(/already displayed/);
  });

  it("服务端失败 → isError 带原因，不落盘", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "quota exhausted" } }, 429)),
    );
    const tool = setup(() => CONFIG);
    const res = await exec(tool, { prompt: "a cat" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("quota exhausted");
    expect(res.details?.images).toBeUndefined();
  });

  it("配置在会话存活期间被清空 → 下一次调用即报错（实时读取兜底）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ b64_json: PNG_B64 }] })),
    );
    let config: ImageGenConfig | null = CONFIG;
    const tool = setup(() => config);
    expect((await exec(tool, { prompt: "a cat" })).isError).toBeFalsy();
    config = null;
    expect((await exec(tool, { prompt: "a cat" })).isError).toBe(true);
  });
});

describe("真网连通性（默认不跑）", () => {
  it.skipIf(!process.env.SPCODE_TEST_NETWORK)(
    "OpenAI Images 真实生成",
    async () => {
      const apiKey = process.env.SPCODE_TEST_IMAGE_KEY ?? "";
      if (!apiKey) return;
      const out = await executeImageGen(
        {
          protocol: "openai-images",
          baseUrl: "https://api.openai.com/v1/images/generations",
          apiKey,
          model: "gpt-image-1",
        },
        "a simple red circle on white background",
        { size: "1024x1024", timeoutMs: 120_000 },
      );
      expect(out.images.length).toBeGreaterThan(0);
    },
    130_000,
  );
});
