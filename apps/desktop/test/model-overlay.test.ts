/**
 * 自定义模型层测试：models.json 合成、来源标记、添加/删除自定义模型（通用机制）。
 * 背景：pi 引擎目录是随包静态 JSON，新模型发布到上游收录可能相隔数周；
 * 本功能让用户在设置页为任意 provider 添加模型，无需手改配置文件。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
  it("无用户文件：受管文件为空 providers，无来源标记", () => {
    const { content, sources, removable } = composeManagedModelsJson(null, null);
    expect(content.providers).toEqual({});
    expect(sources.size).toBe(0);
    expect(removable.size).toBe(0);
  });

  it("两文件同 provider 合并：models 按 id 去重，UI 文件同 id 覆盖手写", () => {
    const handwritten = parseModelsJson(
      JSON.stringify({
        providers: { "kimi-coding": { models: [{ id: "m1", contextWindow: 1 }, { id: "m2" }] } },
      }),
    );
    const uiAdded = parseModelsJson(
      JSON.stringify({ providers: { "kimi-coding": { models: [{ id: "m1", contextWindow: 2 }] } } }),
    );
    const { content, sources, removable } = composeManagedModelsJson(handwritten, uiAdded);
    const models = content.providers["kimi-coding"].models ?? [];
    expect(models.filter((m) => m.id === "m1")).toHaveLength(1);
    expect(models.find((m) => m.id === "m1")?.contextWindow).toBe(2); // UI 覆盖手写
    expect(models.some((m) => m.id === "m2")).toBe(true); // 手写独有条目保留
    expect(sourceOf(sources, "kimi-coding", "m1")).toBe("custom");
    expect(sourceOf(sources, "kimi-coding", "m2")).toBe("custom");
    expect(sourceOf(sources, "kimi-coding", "k3")).toBe("builtin"); // 未声明 = 内置
    expect(removable.has("kimi-coding\0m1")).toBe(true); // UI 文件 → 可删
    expect(removable.has("kimi-coding\0m2")).toBe(false); // 手写 → 不可经 UI 删
  });

  it("provider 级字段保留（透传手写配置）", () => {
    const handwritten = parseModelsJson(
      JSON.stringify({ providers: { openai: { baseUrl: "https://proxy.example.com/v1", models: [] } } }),
    );
    const { content } = composeManagedModelsJson(handwritten, null);
    expect(content.providers.openai.baseUrl).toBe("https://proxy.example.com/v1");
  });
});

describe("parseModelsJson / validateModelInput / buildCustomModelEntry", () => {
  it("坏 JSON 与缺 providers 结构返回 null（不抛）", () => {
    expect(parseModelsJson("{ not json")).toBeNull();
    expect(parseModelsJson(JSON.stringify({ foo: 1 }))).toBeNull();
    expect(parseModelsJson("")).toBeNull();
  });

  it("模型 ID 校验：空 / 含斜线拒绝；上下文需为正数", () => {
    expect(validateModelInput({ modelId: "  ", contextWindow: 1 })).toBe("models.invalidId");
    expect(validateModelInput({ modelId: "a/b", contextWindow: 1 })).toBe("models.invalidId");
    expect(validateModelInput({ modelId: "k3.1-pro", contextWindow: 0 })).toBe("models.invalidContext");
    expect(validateModelInput({ modelId: "k3.1-pro", contextWindow: 262144 })).toBeNull();
  });

  it("表单条目：留空名称省略字段；推理开关决定思考档位映射；视觉决定 input；通用不写死", () => {
    const plain = buildCustomModelEntry({ modelId: "any-model", contextWindow: 100, reasoning: false, vision: false });
    expect(plain.name).toBeUndefined();
    expect(plain.thinkingLevelMap).toBeUndefined();
    expect(plain.input).toEqual(["text"]);
    const full = buildCustomModelEntry({
      modelId: "another-model",
      displayName: "Another",
      contextWindow: 100,
      reasoning: true,
      vision: true,
    });
    expect(full.name).toBe("Another");
    expect(full.thinkingLevelMap?.max).toBe("max");
    expect(full.input).toEqual(["text", "image"]);
  });
});

describe("ModelOverlayStore（临时目录，真实文件读写）", () => {
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), "spcode-overlay-"));
    return createModelOverlayStore(dir);
  };

  it("手写坏文件：合成不抛、受管文件为空，等效无自定义", () => {
    const store = setup();
    writeFileSync(store.userPath, "{ broken", "utf-8");
    syncManagedModelsJson(store);
    const managed = JSON.parse(readFileSync(store.managedPath, "utf-8"));
    expect(managed.providers).toEqual({});
    expect(sourceOfModel(store, "kimi-coding", "k3")).toBe("builtin");
  });

  it("addCustomModel：写 models.custom.json、受管文件更新、标记 custom 且可删；不动手写文件", () => {
    const store = setup();
    writeFileSync(
      store.userPath,
      JSON.stringify({ providers: { "kimi-coding": { models: [{ id: "hand-written" }] } } }),
      "utf-8",
    );
    syncManagedModelsJson(store);
    addCustomModel(store, {
      provider: "kimi-coding",
      modelId: "k3.1-pro",
      contextWindow: 262144,
      reasoning: true,
      vision: true,
    });
    // 手写文件内容未被改写（本功能只写 custom 文件）
    const handwritten = JSON.parse(readFileSync(store.userPath, "utf-8"));
    expect(handwritten.providers["kimi-coding"].models).toEqual([{ id: "hand-written" }]);
    const custom = JSON.parse(readFileSync(store.customPath, "utf-8"));
    expect(custom.providers["kimi-coding"].models).toHaveLength(1);
    const managed = JSON.parse(readFileSync(store.managedPath, "utf-8"));
    const ids = managed.providers["kimi-coding"].models.map((m: { id: string }) => m.id);
    expect(ids).toContain("k3.1-pro");
    expect(ids).toContain("hand-written"); // 手写条目合并保留
    expect(sourceOfModel(store, "kimi-coding", "k3.1-pro")).toBe("custom");
    expect(isRemovable(store, "kimi-coding", "k3.1-pro")).toBe(true);
    expect(isRemovable(store, "kimi-coding", "hand-written")).toBe(false);
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

  it("removeCustomModel：删除 UI 添加的模型；手写与内置模型拒绝删除", () => {
    const store = setup();
    writeFileSync(
      store.userPath,
      JSON.stringify({ providers: { "kimi-coding": { models: [{ id: "hand-written" }] } } }),
      "utf-8",
    );
    syncManagedModelsJson(store);
    addCustomModel(store, { provider: "kimi-coding", modelId: "m", contextWindow: 1, reasoning: false, vision: false });
    removeCustomModel(store, "kimi-coding", "m");
    const custom = JSON.parse(readFileSync(store.customPath, "utf-8"));
    expect(custom.providers["kimi-coding"].models).toHaveLength(0);
    expect(() => removeCustomModel(store, "kimi-coding", "hand-written")).toThrow("models.notRemovable");
    expect(() => removeCustomModel(store, "kimi-coding", "k3")).toThrow("models.notRemovable");
  });
});

describe("与真实 ModelRuntime 集成（allowModelNetwork=false）", () => {
  it("添加任意模型 → refresh 即出现在目录 → 删除后消失；内置模型不受影响", async () => {
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
    // 目录与引擎内置一致（无写死注入）
    expect(kimiModels()).not.toContain("k3.1-pro");

    // 添加自定义模型 → refresh 即时生效（无需重建 runtime）
    addCustomModel(store, {
      provider: "kimi-coding",
      modelId: "k3.1-pro",
      contextWindow: 262144,
      reasoning: true,
      vision: false,
    });
    await rt.refresh({ allowNetwork: false });
    expect(kimiModels()).toContain("k3.1-pro");
    expect(kimiModels()).toContain("k3"); // 内置模型未被挤掉

    // 删除 → refresh 后消失；内置模型不可删
    removeCustomModel(store, "kimi-coding", "k3.1-pro");
    await rt.refresh({ allowNetwork: false });
    expect(kimiModels()).not.toContain("k3.1-pro");
    expect(kimiModels()).toContain("k3");
    expect(() => removeCustomModel(store, "kimi-coding", "k3")).toThrow("models.notRemovable");
  }, 30_000);
});
