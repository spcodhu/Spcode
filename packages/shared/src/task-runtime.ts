/** Host-owned Task contract. Limits count work requests, not HTTP retries or a cost cap. */
export type TaskRole = "readonly" | "write";
export type TaskStatus = "completed" | "partial" | "blocked" | "cancelled" | "failed";

export interface TaskLimits {
  childTurns: number;
  childWallTimeMs: number;
  treeTurns: number;
  treeWallTimeMs: number;
  activeTasks: number;
  maxDepth: number;
}

export const DEFAULT_TASK_LIMITS: Readonly<TaskLimits> = Object.freeze({
  childTurns: 64,
  childWallTimeMs: 15 * 60_000,
  treeTurns: 128,
  treeWallTimeMs: 30 * 60_000,
  activeTasks: 3,
  maxDepth: 2,
});
export const TASK_SUMMARY_MAX_TOKENS = 2048;

/** Settings may lower limits, never silently disable the finite host ceiling. */
export function normalizeTaskLimits(value?: Partial<TaskLimits>): TaskLimits {
  const result = { ...DEFAULT_TASK_LIMITS };
  for (const key of Object.keys(result) as (keyof TaskLimits)[]) {
    const n = value?.[key];
    if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) result[key] = Math.min(n, result[key]);
  }
  return result;
}

export interface TaskBudgetRequest {
  maxTurns?: number;
  wallTimeMs?: number;
}

export interface TaskInput {
  description: string;
  /** Legacy self-contained instructions remain supported. */
  prompt: string;
  goal?: string;
  background?: string;
  scope?: string[];
  acceptance?: string[];
  evidenceRefs?: string[];
  role?: TaskRole;
  budget?: TaskBudgetRequest;
}

export interface TaskUsage {
  /** Includes descendants; informational only, do not emit this aggregate to the billing ledger. */
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costTotal: number;
  requests: number;
  auxiliaryRequests: number;
}

export interface TaskToolEvidence {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  /** Only host-observed execution results, not an assistant's claim. */
  evidenceRefs: string[];
}

export interface TaskArtifact {
  toolCallId: string;
  path: string;
  operation: "write" | "edit";
}

export interface TaskResult {
  schemaVersion: 1;
  taskId: string;
  description: string;
  status: TaskStatus;
  /** Model-authored, bounded and explicitly not verification evidence. */
  summary: string;
  evidenceRefs: string[];
  artifacts: TaskArtifact[];
  usage: TaskUsage;
  unresolved: string[];
  /** Criteria stay unverified unless the host has a dedicated verifier. */
  acceptance: { criterion: string; status: "unverified"; evidenceRefs: string[] }[];
  toolEvidence: TaskToolEvidence[];
}

// ---------------------------------------------------------------------------
// 子任务活动快照（session.task 事件 wire 格式）
// ---------------------------------------------------------------------------

/** queued = 已登记等待并发槽/写租约；running = 已占槽执行；终态与 TaskStatus 同词表。 */
export type TaskActivityStatus = "queued" | "running" | TaskStatus;

/** 与计费同源的用量活账本快照；仅展示用，不重复计入账本。 */
export interface TaskActivityUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costTotal: number;
}

/** 宿主在子任务生命周期内按 taskId 覆盖式下发的进度快照。 */
export interface TaskActivity {
  schemaVersion: 1;
  taskId: string;
  /** null = 由根会话直接派生，否则为父 TaskRun 的 id（嵌套子任务）。 */
  parentTaskId: string | null;
  /** 根会话里发起（或逐级派生）该子任务的 Task 工具调用 id。 */
  sourceToolCallId: string;
  description: string;
  role: TaskRole;
  depth: number;
  status: TaskActivityStatus;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  turns: number;
  maxTurns: number;
  usage: TaskActivityUsage;
  /** 子代理最近一次工具调用名（如 read/grep）。 */
  lastTool?: string;
  /** 仅终态携带：模型总结的有界摘录。 */
  summary?: string;
}

export const TASK_ACTIVITY_SUMMARY_MAX_CHARS = 400;

const TASK_ACTIVITY_STATUSES: readonly TaskActivityStatus[] = [
  "queued",
  "running",
  "completed",
  "partial",
  "blocked",
  "cancelled",
  "failed",
];

/**
 * Wire 守卫：归一化未知来源的 session.task 载荷（长度截断、数值回退），
 * 结构不可用时返回 null。宿主侧产出即本格式；渲染层消费前必须过这一道。
 */
export function normalizeTaskActivity(value: unknown): TaskActivity | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.taskId !== "string" || !raw.taskId) return null;
  const text = (input: unknown, max: number): string => (typeof input === "string" ? input.slice(0, max) : "");
  const count = (input: unknown): number =>
    typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : 0;
  const status = TASK_ACTIVITY_STATUSES.includes(raw.status as TaskActivityStatus)
    ? (raw.status as TaskActivityStatus)
    : "running";
  const usage = (raw.usage ?? {}) as Record<string, unknown>;
  const endedAt = raw.endedAt;
  return {
    schemaVersion: 1,
    taskId: raw.taskId,
    parentTaskId: typeof raw.parentTaskId === "string" && raw.parentTaskId ? raw.parentTaskId : null,
    sourceToolCallId: text(raw.sourceToolCallId, 128),
    description: text(raw.description, 200),
    role: raw.role === "write" ? "write" : "readonly",
    depth:
      typeof raw.depth === "number" && Number.isSafeInteger(raw.depth) && raw.depth >= 0 ? Math.min(raw.depth, 8) : 0,
    status,
    startedAt: count(raw.startedAt),
    updatedAt: count(raw.updatedAt),
    ...(typeof endedAt === "number" && Number.isFinite(endedAt) && endedAt >= 0 ? { endedAt } : {}),
    turns: count(raw.turns),
    maxTurns: count(raw.maxTurns),
    usage: {
      input: count(usage.input),
      output: count(usage.output),
      cacheRead: count(usage.cacheRead),
      cacheWrite: count(usage.cacheWrite),
      costTotal: count(usage.costTotal),
    },
    ...(typeof raw.lastTool === "string" && raw.lastTool ? { lastTool: raw.lastTool.slice(0, 64) } : {}),
    ...(typeof raw.summary === "string" && raw.summary
      ? { summary: raw.summary.slice(0, TASK_ACTIVITY_SUMMARY_MAX_CHARS) }
      : {}),
  };
}
