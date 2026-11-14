/**
 * 自定义供应商与模型的宿主侧管理：受管 models.managed.json 的生成与维护（通用机制）。
 *
 * 用户在设置页添加供应商 / 模型 → 写 models.custom.json → 与手写 models.json
 * 合成为受管文件交给 ModelRuntime。既可接入 Pi 目录外的兼容端点，也可在
 * pi 目录更新滞后时为已有供应商补充新模型。
 *
 * 数据流（两个用户文件，职责分离）：
 *   agent/models.json          用户手写，只读（pi 原生配置入口；坏文件由 pi 自行报错）
 *   agent/models.custom.json   设置页供应商 / 模型管理读写（本模块唯一改写对象）
 *   agent/models.managed.json  受管合成 = models.json ∪ models.custom.json → ModelRuntime
 *
 * 设计要点：
 * - 绝不改写用户手写的 models.json（避免丢失注释/格式，也是魔改用户的安全边界）。
 * - 两个用户文件损坏时受管文件为空：pi 本就解析不了坏文件（等价行为），等效无自定义。
 * - source/removable 判定表随每次合成刷新：手写与 UI 添加同为 custom 标签，
 *   仅 UI 添加的模型可经 models.removeModel 删除（手写条目请在文件里自行删除）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelSource, ModelsJsonProviderEntry } from "@spcode/shared";
import {
  type AddCustomModelInput,
  buildCustomModelEntry,
  buildCustomProviderEntry,
  type CustomProviderInput,
  composeManagedModelsJson,
  parseModelsJson,
  sourceOf,
  validateCustomProviderInput,
  validateModelInput,
} from "@spcode/shared";
import { writeJsonFileAtomic } from "@spcode/shared/node";

export interface ModelOverlayStore {
  /** 用户手写 models.json（只读） */
  userPath: string;
  /** 设置页供应商 / 模型管理的专属文件（读写） */
  customPath: string;
  managedPath: string;
  sources: Map<string, ModelSource>;
  removable: Set<string>;
  /** 设置页创建的完整供应商（仅安全配置字段，不含 apiKey） */
  customProviders: Map<string, Omit<CustomProviderInput, "apiKey">>;
}

export function createModelOverlayStore(agentDir: string): ModelOverlayStore {
  return {
    userPath: join(agentDir, "models.json"),
    customPath: join(agentDir, "models.custom.json"),
    managedPath: join(agentDir, "models.managed.json"),
    sources: new Map(),
    removable: new Set(),
    customProviders: new Map(),
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
  const handwritten = readModelsFile(store.userPath);
  const uiAdded = readModelsFile(store.customPath);
  const { content, sources, removable } = composeManagedModelsJson(handwritten, uiAdded);
  store.sources = sources;
  store.removable = removable;
  store.customProviders.clear();
  for (const [provider, entry] of Object.entries(uiAdded?.providers ?? {})) {
    if (isUiCustomProviderEntry(entry)) {
      store.customProviders.set(provider, {
        provider,
        name: entry.name,
        baseUrl: entry.baseUrl,
        api: entry.api,
      });
    }
  }
  writeJsonFileAtomic(store.managedPath, content);
}

/** 只有带完整供应商字段的 UI 条目可编辑；只有 models 的旧条目仍是内置供应商的模型 overlay。 */
function isUiCustomProviderEntry(entry: {
  name?: unknown;
  baseUrl?: unknown;
  api?: unknown;
}): entry is ModelsJsonProviderEntry & { name: string; baseUrl: string; api: string } {
  return typeof entry.name === "string" && typeof entry.baseUrl === "string" && typeof entry.api === "string";
}

export function customProviderConfig(
  store: ModelOverlayStore,
  provider: string,
): Omit<CustomProviderInput, "apiKey"> | undefined {
  return store.customProviders.get(provider);
}

/** 新增完整供应商；宿主还会拒绝与 Pi 内置供应商同 ID。 */
export function addCustomProvider(store: ModelOverlayStore, input: CustomProviderInput): void {
  const invalid = validateCustomProviderInput(input);
  if (invalid) throw new Error(invalid);
  const provider = input.provider.trim();
  const data = readModelsFile(store.customPath) ?? { providers: {} };
  if (data.providers[provider] || readModelsFile(store.userPath)?.providers[provider]) {
    throw new Error("models.providerExists");
  }
  data.providers[provider] = buildCustomProviderEntry(input);
  writeJsonFileAtomic(store.customPath, data);
  syncManagedModelsJson(store);
}

/** 编辑名称 / Base URL / 协议，保留既有模型与其他 Pi 兼容字段；ID 不可变。 */
export function updateCustomProvider(store: ModelOverlayStore, input: CustomProviderInput): void {
  const invalid = validateCustomProviderInput(input);
  if (invalid) throw new Error(invalid);
  const provider = input.provider.trim();
  const data = readModelsFile(store.customPath);
  const current = data?.providers[provider];
  if (!data || !current || !isUiCustomProviderEntry(current)) throw new Error("models.providerNotEditable");
  data.providers[provider] = {
    ...current,
    ...buildCustomProviderEntry(input),
    models: current.models ?? [],
  };
  writeJsonFileAtomic(store.customPath, data);
  syncManagedModelsJson(store);
}

/** 仅删除设置页创建的完整供应商；手写配置与内置供应商拒绝删除。 */
export function removeCustomProvider(store: ModelOverlayStore, provider: string): void {
  const data = readModelsFile(store.customPath);
  const current = data?.providers[provider];
  if (!data || !current || !isUiCustomProviderEntry(current)) throw new Error("models.providerNotEditable");
  delete data.providers[provider];
  writeJsonFileAtomic(store.customPath, data);
  syncManagedModelsJson(store);
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
