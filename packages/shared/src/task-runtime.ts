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
