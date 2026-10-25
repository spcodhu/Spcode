/**
 * 自定义模型层：设置页「添加模型」与 models.json 的合成功能（通用机制，不写死任何模型）。
 *
 * 背景：pi 引擎的模型目录是随包发布的静态 JSON，新模型从发布到被上游收录可能滞后
 * 数周。本模块提供通用逃生舱：用户在任意 provider 详情页填写 模型 ID / 显示名 /
 * 上下文长度 / 推理 / 视觉 即可添加模型，按该 provider 默认协议请求。
 *
 * 数据流（两个用户文件，职责分离）：
 *   agent/models.json          用户手写，只读（pi 原生配置入口；坏文件由 pi 自行报错）
 *   agent/models.custom.json   设置页「添加模型」读写（本模块唯一改写对象）
 *   agent/models.managed.json  受管合成 = models.json ∪ models.custom.json → ModelRuntime
 *
 * 纯函数、无 Node 依赖：文件读写留在 agent-host，便于单元测试。
 */

/** 模型条目的来源：pi 内置目录 / 用户自定义（手写 models.json 与 UI 添加） */
export type ModelSource = "builtin" | "custom";

/** models.json 中单个模型条目的最小结构（对齐 pi 的 ModelDefinitionSchema） */
export interface ModelsJsonModelEntry {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: ("text" | "image")[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
}

/** models.json 中单个 provider 条目（只声明我们关心的字段，其余原样透传） */
export interface ModelsJsonProviderEntry {
  models?: ModelsJsonModelEntry[];
  [key: string]: unknown;
}

export interface ModelsJsonFile {
  providers: Record<string, ModelsJsonProviderEntry>;
  [key: string]: unknown;
}

/** 合成结果：受管文件内容 + 来源/可删性判定表（"provider\0modelId"，不在表内 = builtin） */
export interface ComposeResult {
  content: ModelsJsonFile;
  sources: Map<string, ModelSource>;
  /** UI 添加（models.custom.json）的模型可经 removeModel 删除；手写条目只读 */
  removable: Set<string>;
}

/** 容错解析 models.json；坏文件返回 null（由调用方决定降级策略，不抛异常） */
export function parseModelsJson(text: string | undefined | null): ModelsJsonFile | null {
  if (!text?.trim()) return null;
  try {
    const data = JSON.parse(text) as ModelsJsonFile;
    if (!data || typeof data !== "object" || !data.providers || typeof data.providers !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 合成受管 models.json：手写与 UI 两个文件合并，同 provider 的 models 按 id 去重、
 * 后者胜（UI 文件在手写之后 → UI 同 ID 覆盖手写，对齐 pi applyModelsJson 语义）。
 * provider 级字段以 UI 文件为先（UI 文件仅由添加模型写入，实际只含 models）。
 */
export function composeManagedModelsJson(
  handwritten: ModelsJsonFile | null,
  uiAdded: ModelsJsonFile | null,
): ComposeResult {
  const sources = new Map<string, ModelSource>();
  const removable = new Set<string>();
  const providers: Record<string, ModelsJsonProviderEntry> = {};

  for (const [file, isUi] of [
    [handwritten, false],
    [uiAdded, true],
  ] as const) {
    for (const [pid, entry] of Object.entries(file?.providers ?? {})) {
      const prev = providers[pid];
      // 同 id 去重、后者胜：先收录前序文件条目，再被本文件同 id 覆盖
      const byId = new Map<string, ModelsJsonModelEntry>();
      for (const m of [...(prev?.models ?? []), ...(entry.models ?? [])]) byId.set(m.id, m);
      providers[pid] = { ...prev, ...entry, models: [...byId.values()] };
      for (const m of entry.models ?? []) {
        if (m && typeof m.id === "string") {
          sources.set(`${pid}\0${m.id}`, "custom");
          if (isUi) removable.add(`${pid}\0${m.id}`);
        }
      }
    }
  }

  return { content: { providers }, sources, removable };
}

/** 判定合成目录里某模型的来源（builtin = 两个用户文件都没声明） */
export function sourceOf(sources: Map<string, ModelSource>, provider: string, modelId: string): ModelSource {
  return sources.get(`${provider}\0${modelId}`) ?? "builtin";
}

/** 设置页「添加模型」表单 → models.json 模型条目。
 *  api/baseUrl 省略：继承该 provider 目录默认协议，因此同一表单适用于任何 provider。 */
export function buildCustomModelEntry(input: {
  modelId: string;
  displayName?: string;
  contextWindow: number;
  reasoning: boolean;
  vision: boolean;
}): ModelsJsonModelEntry {
  return {
    id: input.modelId,
    ...(input.displayName?.trim() ? { name: input.displayName.trim() } : {}),
    reasoning: input.reasoning,
    // 思考档位映射 low/high/max + off 关闭（对齐 kimi 系等主流推理模型约定）；
    // 非推理模型不声明（引擎视为无档位）
    ...(input.reasoning
      ? {
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: "low",
            medium: null,
            high: "high",
            xhigh: null,
            max: "max",
          },
        }
      : {}),
    input: input.vision ? ["text", "image"] : ["text"],
    // 订阅 provider 不按 token 计价；按量 provider 的自定义模型仅影响用量展示精度
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: input.contextWindow,
    maxTokens: 131072,
  };
}

/** 表单校验：返回错误文案 key（null = 通过）。i18n 在渲染层做。 */
export function validateModelInput(input: {
  modelId: string;
  contextWindow: number;
}): "models.invalidId" | "models.invalidContext" | null {
  const id = input.modelId.trim();
  if (!id || id.includes("/") || id.includes("\0") || id.length > 128) return "models.invalidId";
  if (!Number.isFinite(input.contextWindow) || input.contextWindow <= 0 || input.contextWindow > 10_000_000) {
    return "models.invalidContext";
  }
  return null;
}
