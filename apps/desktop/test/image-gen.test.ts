/**
 * 生图技能测试：千问同步协议、自定义 Body/响应映射、GenerateImage 工具落盘与配置 sanitize。
 * 真网连通性默认不跑（SPCODE_TEST_NETWORK=1 显式开启，密钥与模型均由环境变量提供）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageGenConfig } from "@spcode/shared";
import {
  buildCustomImageGenBody,
  buildQwenImageGenBody,
  executeImageGen,
  isImageGenReady,
  isValidImageGenResponsePath,
  parseCustomImageGenResponse,
  parseDataUrl,
  parseQwenImageGenResponse,
  QWEN_IMAGE_GEN_ENDPOINT,
  sanitizeImageGenConfig,
  sizeToQwenSize,
  sniffImageMime,
  validateImageGenRequestBody,
} from "@spcode/shared/image-gen";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createImageGenTool } from "../src/agent-host/tools/image-gen.js";

/** 1x1 透明 PNG（真实魔数，sniff/落盘断言用） */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

const CONFIG: ImageGenConfig = {
  protocol: "qwen",
  baseUrl: QWEN_IMAGE_GEN_ENDPOINT,
  apiKey: "sk-test",
  model: "user-selected-qwen-model",
};

const CUSTOM_CONFIG: ImageGenConfig = {
  protocol: "custom",
  baseUrl: "https://image.example.com/generate",
  apiKey: "custom-key",
  model: "custom-model",
  requestBody: `{
    "model": "{{model}}",
    "input": { "text": "{{prompt}}", "summary": "Draw: {{prompt}}" },
    "width": "{{width}}",
    "height": "{{height}}",
    "size": "{{size}}",
    "count": "{{n}}",
    "key": "{{apiKey}}"
  }`,
  responsePath: "result.images[*].url",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function qwenResponse(image: string, text?: string): unknown {
  return {
    output: {
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: [...(text ? [{ text }] : []), { image }],
          },
        },
      ],
    },
    request_id: "req-test",
  };
}

describe("sanitizeImageGenConfig / isImageGenReady", () => {
  it("千问配置原样保留；模型由用户填写且不能为空", () => {
    expect(sanitizeImageGenConfig(CONFIG)).toEqual(CONFIG);
    expect(isImageGenReady(CONFIG)).toBe(true);
    expect(isImageGenReady({ ...CONFIG, model: " " })).toBe(false);
  });

  it("自定义配置保留完整 Body 与响应路径", () => {
    expect(sanitizeImageGenConfig(CUSTOM_CONFIG)).toEqual(CUSTOM_CONFIG);
    expect(isImageGenReady(CUSTOM_CONFIG)).toBe(true);
  });

  it("旧协议 / 非对象 / 缺字段一律判 null（未配置）", () => {
    expect(sanitizeImageGenConfig({ ...CONFIG, protocol: "openai-images" })).toBeNull();
    expect(sanitizeImageGenConfig({ ...CONFIG, protocol: "gemini" })).toBeNull();
    expect(sanitizeImageGenConfig({ ...CONFIG, apiKey: 123 })).toBeNull();
    expect(sanitizeImageGenConfig({ ...CUSTOM_CONFIG, requestBody: undefined })).toBeNull();
    expect(sanitizeImageGenConfig({ ...CUSTOM_CONFIG, responsePath: undefined })).toBeNull();
    expect(sanitizeImageGenConfig(null)).toBeNull();
    expect(sanitizeImageGenConfig([CONFIG])).toBeNull();
  });

  it("自定义 Body 或响应路径无效时不 ready（fail-safe）", () => {
    expect(isImageGenReady({ ...CUSTOM_CONFIG, requestBody: "{" })).toBe(false);
    expect(isImageGenReady({ ...CUSTOM_CONFIG, requestBody: '{"prompt":"fixed"}' })).toBe(false);
    expect(isImageGenReady({ ...CUSTOM_CONFIG, responsePath: "" })).toBe(false);
    expect(isImageGenReady({ ...CUSTOM_CONFIG, responsePath: "data[..]x" })).toBe(false);
    expect(isImageGenReady(null)).toBe(false);
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
    expect(parseDataUrl(PNG_DATA_URL)).toEqual({ mimeType: "image/png", data: PNG_B64 });
    expect(parseDataUrl("https://example.com/a.png")).toBeNull();
    expect(parseDataUrl("data:text/plain;base64,aGk=")).toBeNull();
    expect(parseDataUrl("data:image/png;base64,")).toBeNull();
  });

  it("千问尺寸统一转换为 宽*高", () => {
    expect(sizeToQwenSize("1024x1024")).toBe("1024*1024");
    expect(sizeToQwenSize("1536×1024")).toBe("1536*1024");
    expect(sizeToQwenSize("2048*2048")).toBe("2048*2048");
    expect(sizeToQwenSize("auto")).toBeNull();
    expect(sizeToQwenSize(undefined)).toBeNull();
  });
});

describe("自定义请求 Body 模板", () => {
  it("校验 JSON、顶层对象与 prompt 占位符", () => {
    expect(validateImageGenRequestBody(CUSTOM_CONFIG.requestBody ?? "")).toBeNull();
    expect(validateImageGenRequestBody("")).toBe("empty");
    expect(validateImageGenRequestBody("{")).toBe("invalidJson");
    expect(validateImageGenRequestBody("[]")).toBe("notObject");
    expect(validateImageGenRequestBody('{"prompt":"fixed"}')).toBe("missingPrompt");
  });

  it("占位符递归替换，引号与换行不会破坏 JSON；数字占位符保留类型", () => {
    const prompt = 'a "cat"\nwith a second line \\ safe';
    const body = buildCustomImageGenBody(CUSTOM_CONFIG, prompt, "1536x1024");
    expect(body.model).toBe("custom-model");
    expect(body.input).toEqual({ text: prompt, summary: `Draw: ${prompt}` });
    expect(body.width).toBe(1536);
    expect(body.height).toBe(1024);
    expect(body.size).toBe("1536x1024");
    expect(body.count).toBe(1);
    expect(body.key).toBe("custom-key");
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });

  it("响应路径支持下标、通配与直接指向字符串数组", () => {
    expect(isValidImageGenResponsePath("data[0].b64_json")).toBe(true);
    expect(isValidImageGenResponsePath("output.choices[*].message.content[*].image")).toBe(true);
    expect(isValidImageGenResponsePath("images")).toBe(true);
    expect(isValidImageGenResponsePath("")).toBe(false);
    expect(isValidImageGenResponsePath("data[..]x")).toBe(false);
  });
});

describe("千问同步协议", () => {
  it("请求严格使用官方 input.messages + parameters 结构，模型取用户配置", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(qwenResponse(PNG_DATA_URL)));
    vi.stubGlobal("fetch", fetchMock);
    await executeImageGen(CONFIG, "a cat", { size: "1536x1024" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(QWEN_IMAGE_GEN_ENDPOINT);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "user-selected-qwen-model",
      input: { messages: [{ role: "user", content: [{ text: "a cat" }] }] },
      parameters: {
        n: 1,
        prompt_extend: true,
        watermark: false,
        response_format: "url",
        size: "1536*1024",
      },
    });
  });

  it("未指定尺寸时不强加 size，使用平台模型默认值", () => {
    expect(buildQwenImageGenBody(CONFIG, "a cat").parameters).not.toHaveProperty("size");
  });

  it("解析 output.choices[*].message.content[*].image 与文本附注", async () => {
    const out = await parseQwenImageGenResponse(qwenResponse(PNG_DATA_URL, "done"), new AbortController().signal);
    expect(out.images).toEqual([{ mimeType: "image/png", data: PNG_B64 }]);
    expect(out.text).toBe("done");
  });

  it("临时签名 URL 立即下载，避免 24 小时后失效", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(Buffer.from(PNG_B64, "base64"), { status: 200, headers: { "content-type": "image/png" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await parseQwenImageGenResponse(
      qwenResponse("https://cdn.example.com/result.png?Expires=123"),
      new AbortController().signal,
    );
    expect(out.images[0]).toEqual({ mimeType: "image/png", data: PNG_B64 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cdn.example.com/result.png?Expires=123",
      expect.objectContaining({ redirect: "follow" }),
    );
  });

  it("HTTP 错误带服务端原文", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "Invalid API key" }, 401)),
    );
    await expect(executeImageGen(CONFIG, "a cat")).rejects.toThrow("HTTP 401: Invalid API key");
  });
});

describe("自定义同步协议", () => {
  it("发送用户完整 Body，并按 images[*].url 提取多张图", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ result: { images: [{ url: PNG_DATA_URL }, { url: PNG_DATA_URL }] } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await executeImageGen(CUSTOM_CONFIG, "two cats", { size: "1024x1024" });
    expect(out.images).toHaveLength(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CUSTOM_CONFIG.baseUrl);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer custom-key");
    const body = JSON.parse(init.body as string) as { input: { text: string }; model: string };
    expect(body.input.text).toBe("two cats");
    expect(body.model).toBe("custom-model");
  });

  it("支持原始 base64 与路径直接指向字符串数组", async () => {
    const out = await parseCustomImageGenResponse({ images: [PNG_B64] }, "images", new AbortController().signal);
    expect(out.images).toEqual([{ mimeType: "image/png", data: PNG_B64 }]);
  });

  it("路径无图时给出路径与服务端 message，不猜其它字段", async () => {
    await expect(
      parseCustomImageGenResponse({ message: "bad model", data: [] }, "data[0].url", new AbortController().signal),
    ).rejects.toThrow("data[0].url: bad model");
  });

  it("路径存在但不是图片值时明确报错", async () => {
    await expect(
      parseCustomImageGenResponse({ data: [{ url: "not an image" }] }, "data[0].url", new AbortController().signal),
    ).rejects.toThrow(/not a URL, data URL or base64/);
  });
});

describe("createImageGenTool（落盘、并行声明与门控）", () => {
  let dir = "";

  function setup(getConfig: () => ImageGenConfig | null) {
    dir = mkdtempSync(join(tmpdir(), "spcode-image-gen-"));
    return createImageGenTool({ cwd: dir, getConfig });
  }

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  const exec = (tool: ReturnType<typeof createImageGenTool>, args: Record<string, unknown>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool.execute("t1", args as any, undefined, undefined, {} as any) as Promise<{
      content: { type: string; text?: string }[];
      details?: { images?: { path: string; mimeType: string }[] };
      isError?: boolean;
    }>;

  it("显式声明 parallel，并在工具说明中引导独立调用并行", () => {
    const tool = setup(() => CONFIG);
    expect(tool.executionMode).toBe("parallel");
    expect(tool.description).toMatch(/synchronous/);
    expect(tool.description).toMatch(/parallel/);
  });

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

  it("成功：图片落盘 spcode-images/，details.images 带路径，正文含免重复嵌入提示", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(qwenResponse(PNG_DATA_URL))),
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
    expect(res.content[0]?.text).toContain(path);
    expect(res.content[0]?.text).toMatch(/already displayed/);
  });

  it("服务端失败 → isError 带原因，不落盘", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "quota exhausted" }, 429)),
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
      vi.fn(async () => jsonResponse(qwenResponse(PNG_DATA_URL))),
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
    "千问同步真实生成",
    async () => {
      const apiKey = process.env.SPCODE_TEST_IMAGE_KEY ?? "";
      const model = process.env.SPCODE_TEST_IMAGE_MODEL ?? "";
      if (!apiKey || !model) return;
      const out = await executeImageGen(
        { protocol: "qwen", baseUrl: QWEN_IMAGE_GEN_ENDPOINT, apiKey, model },
        "a simple red circle on white background",
        { size: "1024x1024", timeoutMs: 180_000 },
      );
      expect(out.images.length).toBeGreaterThan(0);
    },
    190_000,
  );
});
