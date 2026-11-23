/**
 * Super Agent 控制面 wire 协议。
 *
 * 浏览器、Electron、Worker 与 CLI 共用这里的类型和边界校验；禁止各端再声明
 * 一份“看起来相同”的请求或快照结构。本文件不依赖 Node / DOM 运行时。
 */

export const SUPERAGENT_PROTOCOL_VERSION = 1 as const;

export const WORK_ITEM_STATES = [
  "PLANNING",
  "AWAITING_PLAN_APPROVAL",
  "QUEUED",
  "RUNNING",
  "VALIDATING",
  "COMMITTING",
  "COMPLETED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
  "RECOVERING",
  "AWAITING_RECONCILIATION",
] as const;

export type WorkItemState = (typeof WORK_ITEM_STATES)[number];
export type DesiredState = "ACTIVE" | "STOPPED";
export type PlanStatus = "PENDING" | "APPROVED" | "SUPERSEDED" | "REJECTED";

export interface WorkItem {
  id: string;
  triggerId: string;
  repo: string;
  title: string;
  request: string;
  status: WorkItemState;
  desiredState: DesiredState;
  currentPlanId: string | null;
  activeAttemptId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PlanRevision {
  id: string;
  workItemId: string;
  revision: number;
  content: string;
  planHash: string;
  baseSha: string;
  verification: string[];
  changeScope: string[];
  publishIntent: boolean;
  effectIntent: string[];
  risk: string;
  status: PlanStatus;
  createdAt: number;
}

export type WorkerRole = "plan" | "execute";

export interface WorkerTestEvidence {
  command: string;
  status: "passed" | "failed" | "skipped";
  exitCode?: number;
  durationMs?: number;
  output?: string;
}

export interface WorkerWorkReport {
  status: "waiting" | "ready" | "blocked" | "failed";
  summary: string;
  tests: WorkerTestEvidence[];
  commitMessage?: string;
  artifacts?: string[];
}

export interface AuditEntry {
  id: number;
  workItemId: string | null;
  actorId: string;
  action: string;
  subjectHash: string | null;
  detail: Record<string, unknown>;
  createdAt: number;
}

export interface SuperAgentServiceSnapshot {
  protocolVersion: typeof SUPERAGENT_PROTOCOL_VERSION;
  startedAt: number;
  database: "sqlite";
  desktopConnected: boolean;
  processingPaused: boolean;
}

export interface SuperAgentSnapshot {
  revision: number;
  enabled: boolean;
  service: SuperAgentServiceSnapshot;
  workItems: WorkItem[];
  plans: PlanRevision[];
  audit: AuditEntry[];
}

export type SuperAgentCommand =
  | {
      type: "workitem.create";
      requestId: string;
      repo: string;
      title: string;
      request: string;
    }
  | {
      type: "plan.submit";
      workItemId: string;
      content: string;
      baseSha: string;
      verification: string[];
      changeScope: string[];
      publishIntent?: boolean;
      effectIntent?: string[];
      risk?: string;
    }
  | {
      type: "plan.approve";
      workItemId: string;
      planId: string;
      planHash: string;
    }
  | { type: "workitem.cancel"; workItemId: string }
  | { type: "workitem.retry"; workItemId: string }
  | { type: "processing.setPaused"; paused: boolean };

export interface SuperAgentChangedEvent {
  type: "superagent.changed";
  sequence: number;
  workItemId?: string;
  at: number;
}

export interface SuperAgentConfig {
  enabled: boolean;
  concurrency: number;
  defaultRepo: string;
  dailyDigestTime: string;
  timezone: string;
  budgetUsd: number;
  authorizedOperators: string[];
  allowedChats: string[];
}

export const DEFAULT_SUPERAGENT_CONFIG: SuperAgentConfig = {
  enabled: false,
  concurrency: 2,
  defaultRepo: "spcodhu/Spcode",
  dailyDigestTime: "09:00",
  timezone: "Asia/Shanghai",
  budgetUsd: 20,
  authorizedOperators: [],
  allowedChats: [],
};

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function stringList(value: unknown, maxItems = 100): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].slice(0, maxItems);
}

/** 设置入口统一 sanitize；外部配置永不直接进入 Gate 或 Worker。 */
export function sanitizeSuperAgentConfig(input: unknown): SuperAgentConfig {
  const value = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const repo = typeof value.defaultRepo === "string" ? value.defaultRepo.trim() : "";
  const time = typeof value.dailyDigestTime === "string" ? value.dailyDigestTime : "";
  const timezone = typeof value.timezone === "string" ? value.timezone.trim() : "";
  return {
    enabled: value.enabled === true,
    concurrency: boundedInteger(value.concurrency, DEFAULT_SUPERAGENT_CONFIG.concurrency, 1, 8),
    defaultRepo: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : DEFAULT_SUPERAGENT_CONFIG.defaultRepo,
    dailyDigestTime: /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : DEFAULT_SUPERAGENT_CONFIG.dailyDigestTime,
    timezone: timezone && timezone.length <= 100 ? timezone : DEFAULT_SUPERAGENT_CONFIG.timezone,
    budgetUsd: boundedNumber(value.budgetUsd, DEFAULT_SUPERAGENT_CONFIG.budgetUsd, 0, 100_000),
    authorizedOperators: stringList(value.authorizedOperators),
    allowedChats: stringList(value.allowedChats),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, maxLength = 100_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function requiredId(value: unknown, field: string): string {
  const id = requiredString(value, field, 200);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid ${field}`);
  return id;
}

function optionalStringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid ${field}`);
  }
  return value.map((item) => requiredString(item, field, 2000));
}

/** API 入站命令运行时校验。返回新对象，避免调用方附带额外字段进入领域层。 */
export function parseSuperAgentCommand(input: unknown): SuperAgentCommand {
  if (!isRecord(input) || typeof input.type !== "string") throw new Error("Invalid command");
  switch (input.type) {
    case "workitem.create":
      return {
        type: input.type,
        requestId: requiredId(input.requestId, "requestId"),
        repo: requiredString(input.repo, "repo", 200),
        title: requiredString(input.title, "title", 300),
        request: requiredString(input.request, "request"),
      };
    case "plan.submit":
      return {
        type: input.type,
        workItemId: requiredId(input.workItemId, "workItemId"),
        content: requiredString(input.content, "content"),
        baseSha: requiredString(input.baseSha, "baseSha", 100),
        verification: optionalStringList(input.verification, "verification"),
        changeScope: optionalStringList(input.changeScope, "changeScope"),
        ...(input.publishIntent === undefined ? {} : { publishIntent: input.publishIntent === true }),
        ...(input.effectIntent === undefined
          ? {}
          : { effectIntent: optionalStringList(input.effectIntent, "effectIntent") }),
        ...(input.risk === undefined ? {} : { risk: requiredString(input.risk, "risk", 20_000) }),
      };
    case "plan.approve":
      return {
        type: input.type,
        workItemId: requiredId(input.workItemId, "workItemId"),
        planId: requiredId(input.planId, "planId"),
        planHash: requiredString(input.planHash, "planHash", 128),
      };
    case "workitem.cancel":
    case "workitem.retry":
      return { type: input.type, workItemId: requiredId(input.workItemId, "workItemId") };
    case "processing.setPaused":
      if (typeof input.paused !== "boolean") throw new Error("Invalid paused");
      return { type: input.type, paused: input.paused };
    default:
      throw new Error("Unknown command");
  }
}

function validateWorkItem(value: unknown): asserts value is WorkItem {
  if (!isRecord(value)) throw new Error("Invalid work item");
  requiredId(value.id, "workItem.id");
  requiredString(value.repo, "workItem.repo", 200);
  requiredString(value.title, "workItem.title", 300);
  requiredString(value.request, "workItem.request");
  if (!WORK_ITEM_STATES.includes(value.status as WorkItemState)) throw new Error("Invalid work item status");
  if (value.desiredState !== "ACTIVE" && value.desiredState !== "STOPPED") throw new Error("Invalid desired state");
  if (typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") throw new Error("Invalid timestamps");
}

function validatePlan(value: unknown): asserts value is PlanRevision {
  if (!isRecord(value)) throw new Error("Invalid plan");
  requiredId(value.id, "plan.id");
  requiredId(value.workItemId, "plan.workItemId");
  requiredString(value.content, "plan.content");
  requiredString(value.planHash, "plan.planHash", 128);
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new Error("Invalid plan revision");
  if (!["PENDING", "APPROVED", "SUPERSEDED", "REJECTED"].includes(String(value.status))) {
    throw new Error("Invalid plan status");
  }
}

/** 网络响应先验证再进入 React；坏快照失败关闭，不用局部脏数据渲染。 */
export function parseSuperAgentSnapshot(value: unknown): SuperAgentSnapshot {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    !Array.isArray(value.workItems) ||
    !Array.isArray(value.plans)
  ) {
    throw new Error("Invalid SuperAgent snapshot");
  }
  if (!isRecord(value.service) || value.service.protocolVersion !== SUPERAGENT_PROTOCOL_VERSION) {
    throw new Error("Unsupported SuperAgent protocol");
  }
  for (const item of value.workItems) validateWorkItem(item);
  for (const plan of value.plans) validatePlan(plan);
  return value as unknown as SuperAgentSnapshot;
}
