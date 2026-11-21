/**
 * 生图技能的渲染层/设置层测试：
 * - details.images → ToolCallState.images（实时事件与历史回放两条链路都不丢图）
 * - 设置存储：skills 字段级 sanitize + 渲染层脱敏/掩码还原往返
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageGenConfig } from "@spcode/shared";
import { SECRET_MASK } from "@spcode/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  redactSettingsForRenderer,
  restoreMaskedSecrets,
  SettingsStore,
  sanitizeAppSettings,
} from "../src/main/settings-store.js";
import { applySessionEvent, extractImages, historyToMessages, type SessionState } from "../src/renderer/src/store.js";

const CONFIG: ImageGenConfig = {
  protocol: "qwen",
  baseUrl: "https://maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation",
  apiKey: "sk-real-secret",
  model: "user-selected-model",
};

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    meta: {
      id: "s1",
      mode: "chat",
      cwd: "",
      title: "t",
      model: null,
      thinkingLevel: "off",
      createdAt: 0,
      updatedAt: 0,
    },
    messages: [],
    running: true,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costInput: 0,
      costOutput: 0,
      costCacheRead: 0,
      costCacheWrite: 0,
      costTotal: 0,
      count: 0,
    },
    lastUsage: null,
    supportedThinkingLevels: [],
    todos: [],
    planMode: false,
    ...overrides,
  };
}

describe("extractImages（details.images 逐项校验）", () => {
  it("合法引用保留，非法项剔除", () => {
    const result = {
      details: {
        images: [
          { path: "/tmp/a.png", mimeType: "image/png" },
          { path: "", mimeType: "image/png" },
          { path: "/tmp/b.png", mimeType: "text/plain" },
          { path: 42 },
          null,
        ],
      },
    };
    expect(extractImages(result)).toEqual([{ path: "/tmp/a.png", mimeType: "image/png" }]);
  });

  it("缺失/非数组/全非法 → undefined", () => {
    expect(extractImages(null)).toBeUndefined();
    expect(extractImages({})).toBeUndefined();
    expect(extractImages({ details: { images: "x" } })).toBeUndefined();
    expect(extractImages({ details: { images: [{ path: 1 }] } })).toBeUndefined();
  });
});

describe("实时事件：tool_execution_end 回填 images", () => {
  it("GenerateImage 完成后工具调用带图片引用", () => {
    const s = makeSession();
    applySessionEvent(s, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "GenerateImage",
      args: { prompt: "a cat" },
    });
    applySessionEvent(s, {
      type: "tool_execution_end",
      toolCallId: "t1",
      isError: false,
      result: {
        content: [{ type: "text", text: "Generated 1 image(s)." }],
        details: { images: [{ path: "/tmp/spcode-images/a.png", mimeType: "image/png" }] },
      },
    });
    const seg = s.messages[0]?.segments[0];
    expect(seg?.kind).toBe("tools");
    if (seg?.kind !== "tools") return;
    expect(seg.calls[0]?.status).toBe("done");
    expect(seg.calls[0]?.images).toEqual([{ path: "/tmp/spcode-images/a.png", mimeType: "image/png" }]);
  });

  it("普通工具不受影响（无 images 字段）", () => {
    const s = makeSession();
    applySessionEvent(s, { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } });
    applySessionEvent(s, {
      type: "tool_execution_end",
      toolCallId: "t1",
      isError: false,
      result: { content: [{ type: "text", text: "content" }] },
    });
    const seg = s.messages[0]?.segments[0];
    expect(seg?.kind === "tools" && seg.calls[0]?.images).toBeUndefined();
  });
});

describe("历史回放：details.images 持久化还原", () => {
  it("重启后工具调用仍带图片引用（画廊不丢图）", () => {
    const out = historyToMessages([
      { role: "user", content: [{ type: "text", text: "画一只猫" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "GenerateImage", arguments: { prompt: "a cat" } }],
      },
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "GenerateImage",
        content: [{ type: "text", text: "Generated 1 image(s)." }],
        details: { images: [{ path: "/tmp/spcode-images/a.png", mimeType: "image/png" }] },
        isError: false,
      },
      { role: "assistant", content: [{ type: "text", text: "画好了" }] },
    ]);
    const tools = out[1]?.segments[0];
    expect(tools?.kind === "tools" && tools.calls[0]?.images).toEqual([
      { path: "/tmp/spcode-images/a.png", mimeType: "image/png" },
    ]);
  });
});

describe("设置存储：skills sanitize 与密钥脱敏往返", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "spcode-skills-settings-"));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("非法 skills 段剔除回落默认；非法技能配置判 null", () => {
    expect(sanitizeAppSettings({ skills: [] as never }).skills).toBeUndefined();
    expect(sanitizeAppSettings({ skills: { imageGen: { ...CONFIG, protocol: "bad" as never } } }).skills).toEqual({
      imageGen: null,
    });
    expect(sanitizeAppSettings({ skills: { imageGen: CONFIG } }).skills).toEqual({ imageGen: CONFIG });
  });

  it("落盘 → 脱敏 → 掩码写回还原真值（渲染层永远见不到明文）", () => {
    const store = new SettingsStore(dir);
    store.set({ skills: { imageGen: CONFIG } });
    expect(store.get().skills.imageGen?.apiKey).toBe("sk-real-secret");

    const redacted = redactSettingsForRenderer(store.get());
    expect(redacted.skills.imageGen?.apiKey).toBe(SECRET_MASK);

    // 渲染层原样写回掩码 = 未修改密钥
    const restored = restoreMaskedSecrets({ skills: redacted.skills }, store.get());
    expect(restored.skills?.imageGen?.apiKey).toBe("sk-real-secret");
    store.set(restored);
    expect(store.get().skills.imageGen?.apiKey).toBe("sk-real-secret");

    // 换新密钥则正常覆盖
    store.set({ skills: { imageGen: { ...CONFIG, apiKey: "sk-new" } } });
    expect(store.get().skills.imageGen?.apiKey).toBe("sk-new");

    // 停用 = null
    store.set({ skills: { imageGen: null } });
    expect(store.get().skills.imageGen).toBeNull();
  });
});
