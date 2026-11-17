import { describe, expect, it, vi } from "vitest";
import { discoverModels } from "../src/agent-host/model-discovery.js";

function mockFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const implementation: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { implementation, calls };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const base = {
  provider: "acme-ai",
  api: "openai-completions",
  baseUrl: "https://api.acme.test/v1/",
  apiKey: "secret-key",
};

describe("自定义供应商模型发现", () => {
  it("OpenAI / TokenHub：URL、Bearer、名称状态与带斜线 ID，过滤离线模型", async () => {
    const { implementation, calls } = mockFetch(() =>
      json({
        object: "list",
        data: [
          { id: "hy4", name: "Hy4", status: "online" },
          { id: "kimi-k3.1-pro", name: "Kimi", status: "pre-offline" },
          { id: "deepseek/deepseek-flash", status: "online" },
          { id: "offline", status: "offline" },
          { id: "old", shutdown_date: "2000-01-01T00:00:00Z" },
        ],
      }),
    );
    const result = await discoverModels(base, implementation);
    expect(calls[0]?.url.href).toBe("https://api.acme.test/v1/models");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer secret-key");
    expect(result.models).toEqual([
      { id: "hy4", displayName: "Hy4", status: "online" },
      { id: "kimi-k3.1-pro", displayName: "Kimi", status: "pre-offline" },
      { id: "deepseek/deepseek-flash", displayName: "deepseek/deepseek-flash", status: "online" },
    ]);
  });

  it("Anthropic：认证头、能力元数据与 after_id 分页", async () => {
    const { implementation, calls } = mockFetch((url) => {
      if (!url.searchParams.has("after_id")) {
        return json({
          data: [
            {
              id: "claude-one",
              display_name: "Claude One",
              lifecycle: "active",
              max_input_tokens: 200000,
              max_tokens: 8192,
              capabilities: { thinking: { supported: true }, image_input: { supported: true } },
            },
          ],
          has_more: true,
          last_id: "claude-one",
        });
      }
      return json({
        data: [{ id: "claude-two", lifecycle: "deprecated" }],
        has_more: false,
      });
    });
    const result = await discoverModels(
      { ...base, api: "anthropic-messages", baseUrl: "https://api.anthropic.test" },
      implementation,
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.href).toBe("https://api.anthropic.test/v1/models?limit=100");
    expect(calls[1]?.url.searchParams.get("after_id")).toBe("claude-one");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("x-api-key")).toBe("secret-key");
    expect(headers.get("anthropic-version")).toBeTruthy();
    expect(result.models[0]).toMatchObject({
      id: "claude-one",
      contextWindow: 200000,
      maxTokens: 8192,
      reasoning: true,
      vision: true,
    });
    expect(result.models[1]?.id).toBe("claude-two");
  });

  it("Anthropic Base URL 已带 /v1 时不重复拼接", async () => {
    const { implementation, calls } = mockFetch(() => json({ data: [], has_more: false }));
    await discoverModels(
      { ...base, api: "anthropic-messages", baseUrl: "https://api.anthropic.test/v1" },
      implementation,
    );
    expect(calls[0]?.url.href).toBe("https://api.anthropic.test/v1/models?limit=100");
  });

  it("Gemini：x-goog-api-key、pageToken、models/ 前缀与 token 限制", async () => {
    const { implementation, calls } = mockFetch((url) => {
      if (!url.searchParams.has("pageToken")) {
        return json({
          models: [
            {
              name: "models/gemini-one",
              displayName: "Gemini One",
              inputTokenLimit: 1000000,
              outputTokenLimit: 65536,
              supportedGenerationMethods: ["generateContent"],
            },
          ],
          nextPageToken: "next",
        });
      }
      return json({
        models: [
          { name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
          { name: "models/gemini-two", supportedGenerationMethods: ["generateContent"] },
        ],
      });
    });
    const result = await discoverModels(
      { ...base, api: "google-generative-ai", baseUrl: "https://generative.test/v1beta" },
      implementation,
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url.searchParams.get("pageToken")).toBe("next");
    expect(new Headers(calls[0]?.init?.headers).get("x-goog-api-key")).toBe("secret-key");
    expect(result.models).toEqual([
      { id: "gemini-one", displayName: "Gemini One", contextWindow: 1000000, maxTokens: 65536 },
      { id: "gemini-two", displayName: "models/gemini-two" },
    ]);
  });

  it("Mistral：/v1/models 与明确的非聊天能力过滤", async () => {
    const { implementation, calls } = mockFetch(() =>
      json({
        data: [
          { id: "chat", capabilities: { completion_chat: true, vision: true } },
          { id: "embedding", capabilities: { completion_chat: false } },
        ],
      }),
    );
    const result = await discoverModels(
      { ...base, api: "mistral-conversations", baseUrl: "https://api.mistral.ai" },
      implementation,
    );
    expect(calls[0]?.url.href).toBe("https://api.mistral.ai/v1/models");
    expect(result.models).toEqual([{ id: "chat", displayName: "chat", vision: true }]);
  });

  it.each([401, 404, 429, 500])("HTTP %i 错误脱敏且保留状态码", async (status) => {
    const { implementation } = mockFetch(() => json({ error: { message: "failed for secret-key" } }, status));
    const pending = discoverModels(base, implementation);
    await expect(pending).rejects.toThrow(`HTTP ${status}: failed for [redacted]`);
    await expect(discoverModels(base, implementation)).rejects.not.toThrow("secret-key");
  });

  it("重定向、非法 JSON、错误结构与超大响应均被拒绝", async () => {
    await expect(
      discoverModels(base, mockFetch(() => new Response(null, { status: 302 })).implementation),
    ).rejects.toThrow("models.discoveryRedirect");
    await expect(discoverModels(base, mockFetch(() => new Response("not-json")).implementation)).rejects.toThrow(
      "models.discoveryInvalidJson",
    );
    await expect(discoverModels(base, mockFetch(() => json({})).implementation)).rejects.toThrow(
      "models.discoveryInvalidResponse",
    );
    await expect(
      discoverModels(
        base,
        mockFetch(
          () =>
            new Response(null, {
              headers: { "content-length": String(3 * 1024 * 1024) },
            }),
        ).implementation,
      ),
    ).rejects.toThrow("models.discoveryResponseTooLarge");
  });

  it("跨页或单页重复 ID 去重；总数超限明确标记 truncated", async () => {
    const data = Array.from({ length: 2005 }, (_, index) => ({ id: `model-${index}` }));
    data.push({ id: "model-0" });
    const { implementation } = mockFetch(() => json({ data }));
    const result = await discoverModels(base, implementation);
    expect(result.models).toHaveLength(2000);
    expect(result.truncated).toBe(true);
    expect(result.warnings).toEqual(["models.discoveryTruncated"]);
  });

  it("不支持的协议在发请求前拒绝", async () => {
    const implementation = vi.fn();
    await expect(discoverModels({ ...base, api: "bedrock-converse-stream" }, implementation)).rejects.toThrow(
      "models.discoveryUnsupported",
    );
    expect(implementation).not.toHaveBeenCalled();
  });
});
