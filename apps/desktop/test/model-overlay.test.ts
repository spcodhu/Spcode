/**
 * 模型目录 overlay 测试：官方补丁合成、来源标记、添加/删除自定义模型。
 * 背景：pi 引擎目录是随包静态 JSON（上游收录新模型滞后可达数周），
 * 由本模块合成「补丁 ∪ 手写 models.json ∪ UI 添加 models.custom.json」的受管文件。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OFFICIAL_MODEL_PATCH,
  buildCustomModelEntry,
  composeManagedModelsJson,
  parseModelsJson,
  sourceOf,
  validateModelInput,
} from "@spcode/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  addCustomModel,
  createModelOverlayStore,
  isRemovable,
  removeCustomModel,
  sourceOfModel,
  syncManagedModelsJson,
} from "../src/agent-host/model-overlay.js";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("composeManagedModelsJson（纯函数）", () => {
  it("无用户文件：仅注入官方补丁并标记 overlay", () => {
    const { content, sources, removable } = composeManagedModelsJson(null, null);
    const kimi = content.providers["kimi-coding"];
    expect(kimi.models?.map((m) => m.id)).toContain("k3.1-pro");
    expect(kimi.models?.map((m) => m.id)).toContain("k3.1-pro-highspeed");
    expect(sourceOf(sources, "kimi-coding", "k3.1-pro")).toBe("overlay");
    expect(sourceOf(sources, "kimi-coding", "k3")).toBe("builtin");
    expect(removable.size).toBe(0);
  });

  it("补丁在前、用户在后：手写同 ID 覆盖补丁并标记 custom", () => {
    const handwritten = parseModelsJson(
      JSON.stringify({
        providers: { "kimi-coding": { models: [{ id: "k3.1-pro", contextWindow: 1048576 }] } },
      }),
    );
    const { content, sources } = composeManagedModelsJson(handwritten, null);
    const models = content.providers["kimi-coding"].models ?? [];
    const ids = models.filter((m) => m.id === "k3.1-pro");
    expect(ids).toHaveLength(1);
    // 用户条目在后（pi applyModelsJson 顺序覆盖 → 用户优先）
    expect(ids[0].contextWindow).toBe(1048576);
    expect(sourceOf(sources, "kimi-coding", "k3.1-pro")).toBe("custom");
    // 未被覆盖的补丁仍是 overlay
    expect(sourceOf(sources, "kimi-coding", "k3.1-pro-highspeed")).toBe("overlay");
  });

  it("UI 添加优先于手写：同 ID 时 UI 条目覆盖且 removable 仅 UI 文件", () => {
    const handwritten = parseModelsJson(
      JSON.stringify({ providers: { deepseek: { models: [{ id: "deepseek-chat" }] } } }),
    );
    const uiAdded = parseModelsJson(
      JSON.stringify({ providers: { deepseek: { models: [{ id: "deepseek-chat", name: "DS" }] } } }),
    );
    const { content, sources, removable } = composeManagedModelsJson(handwritten, uiAdded);
    const models = content.providers["deepseek"].models ?? [];
    expect(models.filter((m) => m.id === "deepseek-chat")).toHaveLength(1);
    expect(models.find((m) => m.id === "deepseek-chat")?.name).toBe("DS");
    expect(sourceOf(sources, "deepseek", "deepseek-chat")).toBe("custom");
    expect(removable.has("deepseek\0deepseek-chat")).toBe(true);
  });

  it("非补丁 provider 的用户条目原样保留（含 provider 级配置透传）", () => {
    const handwritten = parseModelsJson(
      JSON.stringify({
        providers: { openai: { baseUrl: "https://proxy.example.com/v1", models: [] } },
      }),
    );
    const { content } = composeManagedModelsJson(handwritten, null);
    expect(content.providers["openai"].baseUrl).toBe("https://proxy.example.com/v1");
  });
});

describe("parseModelsJson / validateModelInput / buildCustomModelEntry", () => {
  it("坏 JSON 与缺 providers 结构返回 null（不抛）", () => {
    expect(parseModelsJson("{ not json")).toBeNull();
    expect(parseModelsJson(JSON.stringify({ foo: 1 }))).toBeNull();
    expect(parseModelsJson("")).toBeNull();
  });

  it("模型 ID 校验：空 / 含斜线拒绝", () => {
    expect(validateModelInput({ modelId: "  ", contextWindow: 1 })).toBe("models.invalidId");
    expect(validateModelInput({ modelId: "a/b", contextWindow: 1 })).toBe("models.invalidId");
    expect(validateModelInput({ modelId: "k3.1-pro", contextWindow: 0 })).toBe("models.invalidContext");
    expect(validateModelInput({ modelId: "k3.1-pro", contextWindow: 262144 })).toBeNull();
  });

  it("表单条目：留空名称省略字段；推理开关决定思考档位映射；视觉决定 input", () => {
    const plain = buildCustomModelEntry({ modelId: "m1", contextWindow: 100, reasoning: false, vision: false });
    expect(plain.name).toBeUndefined();
    expect(plain.thinkingLevelMap).toBeUndefined();
    expect(plain.input).toEqual(["text"]);
    const full = buildCustomModelEntry({
      modelId: "m2",
      displayName: "M2",
      contextWindow: 100,
      reasoning: true,
      vision: true,
    });
    expect(full.name).toBe("M2");
    expect(full.thinkingLevelMap?.max).toBe("max");
    expect(full.input).toEqual(["text", "image"]);
  });
});

describe("ModelOverlayStore（临时目录，真实文件读写）", () => {
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), "spcode-overlay-"));
    return createModelOverlayStore(dir);
  };

  it("sync 生成受管文件且含补丁；手写坏文件降级为仅补丁", () => {
    const store = setup();
    writeFileSync(store.userPath, "{ broken", "utf-8");
    syncManagedModelsJson(store);
    const managed = JSON.parse(readFileSync(store.managedPath, "utf-8"));
    expect(managed.providers["kimi-coding"].models.map((m: { id: string }) => m.id)).toContain("k3.1-pro");
    expect(sourceOfModel(store, "kimi-coding", "k3.1-pro")).toBe("overlay");
  });

  it("addCustomModel：写 models.custom.json、受管文件更新、标记 custom 且可删", () => {
    const store = setup();
    syncManagedModelsJson(store);
    addCustomModel(store, {
      provider: "kimi-coding",
      modelId: "k3.1-pro-1m",
      contextWindow: 1048576,
      reasoning: true,
      vision: true,
    });
    // 用户手写文件未被创建（本功能只写 custom 文件）
    expect(() => readFileSync(store.userPath, "utf-8")).toThrow();
    const custom = JSON.parse(readFileSync(store.customPath, "utf-8"));
    expect(custom.providers["kimi-coding"].models).toHaveLength(1);
    const managed = JSON.parse(readFileSync(store.managedPath, "utf-8"));
    const ids = managed.providers["kimi-coding"].models.map((m: { id: string }) => m.id);
    expect(ids).toContain("k3.1-pro-1m");
    expect(ids).toContain("k3.1-pro"); // 补丁仍在
    expect(sourceOfModel(store, "kimi-coding", "k3.1-pro-1m")).toBe("custom");
    expect(isRemovable(store, "kimi-coding", "k3.1-pro-1m")).toBe(true);
  });

  it("addCustomModel 同 ID 覆盖不重复；校验失败抛 i18n key", () => {
    const store = setup();
    const input = { provider: "kimi-coding", modelId: "m", contextWindow: 1, reasoning: false, vision: false };
    addCustomModel(store, input);
    addCustomModel(store, { ...input, contextWindow: 999 });
    const custom = JSON.parse(readFileSync(store.customPath, "utf-8"));
    expect(custom.providers["kimi-coding"].models).toHaveLength(1);
    expect(custom.providers["kimi-coding"].models[0].contextWindow).toBe(999);
    expect(() => addCustomModel(store, { ...input, modelId: "a/b" })).toThrow("models.invalidId");
  });

  it("removeCustomModel：删除 UI 添加的模型；补丁与内置模型拒绝删除", () => {
    const store = setup();
    syncManagedModelsJson(store);
    addCustomModel(store, { provider: "kimi-coding", modelId: "m", contextWindow: 1, reasoning: false, vision: false });
    removeCustomModel(store, "kimi-coding", "m");
    const custom = JSON.parse(readFileSync(store.customPath, "utf-8"));
    expect(custom.providers["kimi-coding"].models).toHaveLength(0);
    expect(() => removeCustomModel(store, "kimi-coding", "k3.1-pro")).toThrow("models.notRemovable");
    expect(() => removeCustomModel(store, "kimi-coding", "k3")).toThrow("models.notRemovable");
  });

  it("手写 models.json 的模型标记 custom 但不可经 UI 删除", () => {
    const store = setup();
    writeFileSync(
      store.userPath,
      JSON.stringify({ providers: { "kimi-coding": { models: [{ id: "hand-written" }] } } }),
      "utf-8",
    );
    syncManagedModelsJson(store);
    expect(sourceOfModel(store, "kimi-coding", "hand-written")).toBe("custom");
    expect(isRemovable(store, "kimi-coding", "hand-written")).toBe(false);
    expect(() => removeCustomModel(store, "kimi-coding", "hand-written")).toThrow("models.notRemovable");
  });
});

describe("OFFICIAL_MODEL_PATCH", () => {
  it("k3.1 条目显式声明 api/baseUrl（防升 pi 引擎后继承默认值变行为）", () => {
    for (const m of OFFICIAL_MODEL_PATCH["kimi-coding"]) {
      expect(m.api).toBe("anthropic-messages");
      expect(m.baseUrl).toBe("https://api.kimi.com/coding");
      expect(m.reasoning).toBe(true);
      expect(m.thinkingLevelMap?.off).toBeNull();
      expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
  });
});

describe("与真实 ModelRuntime 集成（allowModelNetwork=false）", () => {
  it("补丁进目录 → addCustomModel 后 refresh 即出现 → remove 后消失", async () => {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    dir = mkdtempSync(join(tmpdir(), "spcode-overlay-rt-"));
    const store = createModelOverlayStore(dir);
    syncManagedModelsJson(store);
    const rt = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: store.managedPath,
      allowModelNetwork: false,
    });
    const kimiModels = () => rt.getModels("kimi-coding").map((m) => m.id);
    // 官方补丁进入引擎目录（上游 pi-ai 0.87.1~1.4.0 均未收录 K3.1）
    expect(kimiModels()).toContain("k3.1-pro");
    expect(kimiModels()).toContain("k3.1-pro-highspeed");
    expect(kimiModels()).toContain("k3"); // 内置模型未被覆盖语义挤掉

    // 添加自定义模型 → refresh 即时生效（无需重建 runtime）
    addCustomModel(store, {
      provider: "kimi-coding",
      modelId: "k3.1-pro-1m",
      contextWindow: 1048576,
      reasoning: true,
      vision: false,
    });
    await rt.refresh({ allowNetwork: false });
    expect(kimiModels()).toContain("k3.1-pro-1m");

    // 删除 → refresh 后消失；补丁与内置模型不可删
    removeCustomModel(store, "kimi-coding", "k3.1-pro-1m");
    await rt.refresh({ allowNetwork: false });
    expect(kimiModels()).not.toContain("k3.1-pro-1m");
    expect(kimiModels()).toContain("k3.1-pro");
    expect(() => removeCustomModel(store, "kimi-coding", "k3.1-pro")).toThrow("models.notRemovable");
  }, 30_000);
});
