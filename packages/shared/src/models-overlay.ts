/**
 * 官方模型补丁与 models.json 合成层。
 *
 * 背景（调研结论）：
 * - pi 引擎的模型目录是随包发布的静态 JSON（providers/data/*.json），上游收录新模型
 *   依赖发版，滞后可达数周（K3.1 已发布而 pi-ai 0.87.1~1.4.0 均未收录）。
 * - pi 支持 models.json 扩展：同名 provider 下声明 models 数组即追加/同 id 覆盖。
 *
 * 本模块维护一份「官方补丁」（已知但上游未收录的模型，如 Kimi K3.1），
 * 由宿主在启动时与用户自有的 models.json 合成为受管文件（models.managed.json）
 * 交给 ModelRuntime —— 用户零操作可见新模型，手写 models.json 依然生效且优先。
 *
 * 纯函数、无 Node 依赖：文件读写留在 agent-host，便于单元测试。
 */

/** 模型条目的来源：pi 内置目录 / 官方补丁（本模块注入）/ 用户自定义（models.json） */
export type ModelSource = "builtin" | "overlay" | "custom";

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

/** 官方补丁：上游目录滞后时由我们补发的模型条目。
 *  显式写 api/baseUrl —— pi 1.x 已把 kimi-coding 协议改为 openai-completions + /coding/v1，
 *  不写死会在升级引擎后静默变行为（pi changelog 1.2.0：models.json 覆盖 kimi-coding
 *  baseUrl 必须带 /v1）。0.87.1 走 anthropic-messages + 无 /v1。 */
export const OFFICIAL_MODEL_PATCH: Readonly<Record<string, readonly ModelsJsonModelEntry[]>> = {
  "kimi-coding": [
    {
      id: "k3.1-pro",
      name: "Kimi K3.1 Pro",
      api: "anthropic-messages",
      baseUrl: "https://api.kimi.com/coding",
      reasoning: true,
      // K3.1 Pro 仅支持思考模式（关思考服务端 400）；档位 low/high/max（官方文档）
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
      input: ["text", "image"],
      // 订阅制额度不按 token 计价（与内置 k3-256k 同为 0）
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // 官方档位表：Plus/Moderato 档 k3.1-pro 上限 262144（1M 需 Pro 档 + [1m] 变体），
      // 取保守值避免低档位用户选到即报错
      contextWindow: 262144,
      maxTokens: 131072,
      compat: { allowEmptySignature: true, forceAdaptiveThinking: true },
    },
    {
      id: "k3.1-pro-highspeed",
      name: "Kimi K3.1 Pro Highspeed",
      api: "anthropic-messages",
      baseUrl: "https://api.kimi.com/coding",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // Highspeed 仅 Pro/Allegretto 及以上档可用，该档上下文上限 1M（官方档位表）
      contextWindow: 1048576,
      maxTokens: 131072,
      compat: { allowEmptySignature: true, forceAdaptiveThinking: true },
    },
  ],
};

/** 合成结果：受管文件内容 + 每个补丁 provider 中被用户同 id 覆盖的模型集合 */
/**
 * 合成结果：受管文件内容 + 来源判定表（"provider\0modelId" → overlay/custom；不在表内 = builtin）
 * removable 表：仅 UI 添加（models.custom.json）的模型可经 removeModel 删除。
 * 手写 models.json 的条目同为 custom 标签但不可经 UI 删除（避免改写用户文件、丢失注释）。
 */
export interface ComposeResult {
  content: ModelsJsonFile;
  sources: Map<string, ModelSource>;
  removable: Set<string>;
}

/** 容错解析 models.json；坏文件返回 null（由调用方决定降级策略，不抛异常） */
export function parseModelsJson(text: string | undefined | null): ModelsJsonFile | null {
  if (!text || !text.trim()) return null;
  try {
    const data = JSON.parse(text) as ModelsJsonFile;
    if (!data || typeof data !== "object" || !data.providers || typeof data.providers !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

/** 合成优先级（后者覆盖前者同 id）：官方补丁 < 手写 models.json < UI 添加 models.custom.json */
export function composeManagedModelsJson(
  handwritten: ModelsJsonFile | null,
  uiAdded: ModelsJsonFile | null,
): ComposeResult {
  const sources = new Map<string, ModelSource>();
  const removable = new Set<string>();
  const providers: Record<string, ModelsJsonProviderEntry> = {};

  const absorb = (file: ModelsJsonFile | null, markRemovable: boolean) => {
    for (const [pid, entry] of Object.entries(file?.providers ?? {})) {
      providers[pid] = entry;
      for (const m of entry.models ?? []) {
        if (m && typeof m.id === "string") {
          sources.set(`${pid}\0${m.id}`, "custom");
          if (markRemovable) removable.add(`${pid}\0${m.id}`);
        }
      }
    }
  };
  absorb(handwritten, false);
  absorb(uiAdded, true);

  for (const [pid, patchModels] of Object.entries(OFFICIAL_MODEL_PATCH)) {
    const userEntry = providers[pid];
    const userModels = userEntry?.models ?? [];
    // 按 id 去重、后者胜：补丁在前、用户在后 → 用户同 id 条目覆盖补丁（对齐 pi applyModelsJson 语义）
    const byId = new Map<string, ModelsJsonModelEntry>();
    for (const m of [...patchModels, ...userModels]) byId.set(m.id, m);
    providers[pid] = { ...(userEntry ?? {}), models: [...byId.values()] };
    for (const m of patchModels) {
      const key = `${pid}\0${m.id}`;
      if (!sources.has(key)) sources.set(key, "overlay");
    }
  }

  return { content: { providers }, sources, removable };
}

/** 判定合成目录里某模型的来源（builtin = 补丁与用户文件都没声明） */
export function sourceOf(sources: Map<string, ModelSource>, provider: string, modelId: string): ModelSource {
  return sources.get(`${provider}\0${modelId}`) ?? "builtin";
}

/** 设置页「添加模型」表单 → models.json 模型条目。
 *  api/baseUrl 省略：继承该 provider 目录默认协议（kimi-coding = anthropic-messages）。 */
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
    // 与 kimi 系内置模型同款的思考档位映射；非推理模型不声明（引擎视为无档位）
    ...(input.reasoning
      ? { thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" } }
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
