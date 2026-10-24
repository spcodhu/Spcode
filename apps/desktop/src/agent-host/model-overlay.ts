/**
 * 模型目录 overlay 的宿主侧管理：受管 models.managed.json 的生成与维护。
 *
 * 数据流（三个文件，职责分离）：
 *   agent/models.json          用户手写，只读（pi 原生配置入口；坏文件由 pi 自行报错）
 *   agent/models.custom.json   设置页「添加模型」读写（本模块唯一改写对象）
 *   agent/models.managed.json  受管合成 = 补丁 ∪ models.json ∪ models.custom.json → ModelRuntime
 *
 * 设计要点：
 * - 绝不改写用户手写的 models.json（避免丢失注释/格式，也是魔改用户的安全边界）。
 * - 两个用户文件损坏时降级为「仅补丁」：pi 本就解析不了坏文件（等价行为），
 *   但受管文件仍可用，官方补丁不随用户文件损坏而丢失。
 * - source/removable 判定表随每次合成刷新，models.catalog 给模型打 builtin/overlay/custom
 *   标签；removable 仅 UI 添加的模型为 true（手写条目请在文件里自行删除）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelSource } from "@spcode/shared";
import {
  buildCustomModelEntry,
  composeManagedModelsJson,
  parseModelsJson,
  sourceOf,
  validateModelInput,
  type AddCustomModelInput,
} from "@spcode/shared";
import { writeJsonFileAtomic } from "@spcode/shared/node";

export interface ModelOverlayStore {
  /** 用户手写 models.json（只读） */
  userPath: string;
  /** 设置页「添加模型」的专属文件（读写） */
  customPath: string;
  managedPath: string;
  sources: Map<string, ModelSource>;
  removable: Set<string>;
}

export function createModelOverlayStore(agentDir: string): ModelOverlayStore {
  return {
    userPath: join(agentDir, "models.json"),
    customPath: join(agentDir, "models.custom.json"),
    managedPath: join(agentDir, "models.managed.json"),
    sources: new Map(),
    removable: new Set(),
  };
}

function readModelsFile(path: string): ReturnType<typeof parseModelsJson> {
  if (!existsSync(path)) return null;
  try {
    return parseModelsJson(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/** 重新合成受管文件并刷新判定表。启动时与每次增删后调用。 */
export function syncManagedModelsJson(store: ModelOverlayStore): void {
  const { content, sources, removable } = composeManagedModelsJson(
    readModelsFile(store.userPath),
    readModelsFile(store.customPath),
  );
  store.sources = sources;
  store.removable = removable;
  writeJsonFileAtomic(store.managedPath, content);
}

export function sourceOfModel(store: ModelOverlayStore, provider: string, modelId: string): ModelSource {
  return sourceOf(store.sources, provider, modelId);
}

export function isRemovable(store: ModelOverlayStore, provider: string, modelId: string): boolean {
  return store.removable.has(`${provider}\0${modelId}`);
}

/** 添加/覆盖自定义模型：写 models.custom.json → 重新合成。返回模型 key。 */
export function addCustomModel(store: ModelOverlayStore, input: AddCustomModelInput): string {
  const invalid = validateModelInput(input);
  if (invalid) throw new Error(invalid);
  const modelId = input.modelId.trim();
  const entry = buildCustomModelEntry({ ...input, modelId });

  const data = readModelsFile(store.customPath) ?? { providers: {} };
  const providerEntry = data.providers[input.provider] ?? {};
  const models = [...(providerEntry.models ?? [])];
  const idx = models.findIndex((m) => m?.id === modelId);
  if (idx >= 0) models[idx] = entry;
  else models.push(entry);
  data.providers[input.provider] = { ...providerEntry, models };

  writeJsonFileAtomic(store.customPath, data);
  syncManagedModelsJson(store);
  return `${input.provider}/${modelId}`;
}

/** 仅允许删除 models.custom.json 里声明的模型；手写/内置/补丁模型抛错。 */
export function removeCustomModel(store: ModelOverlayStore, provider: string, modelId: string): void {
  if (!isRemovable(store, provider, modelId)) throw new Error("models.notRemovable");
  const data = readModelsFile(store.customPath);
  const providerEntry = data?.providers[provider];
  if (!data || !providerEntry) throw new Error("models.notRemovable");

  providerEntry.models = (providerEntry.models ?? []).filter((m) => m?.id !== modelId);
  writeJsonFileAtomic(store.customPath, data);
  syncManagedModelsJson(store);
}
