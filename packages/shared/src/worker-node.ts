import type { AttemptSnapshot, PlanRevision, WorkerWorkReport, WorkItem } from "./superagent.js";

export const WORKER_NODE_PROTOCOL_VERSION = 1 as const;

export interface WorkerNodeCapabilities {
  platform: string;
  hostname: string;
  capacity: number;
  repos: string[];
  models: string[];
}

export interface RecoveryBundle {
  id: string;
  workItemId: string;
  attemptId: string | null;
  bundleHash: string;
  snapshotVersion: number;
  fence: number;
  mode: "clean" | "review";
  payload: {
    worktreePath: string | null;
    branch: string | null;
    baseSha: string | null;
    sessionFile: string | null;
    planHash: string | null;
    report: WorkerWorkReport | null;
    diff: unknown;
  };
}

export interface WorkerAssignment {
  workItem: WorkItem;
  plan: PlanRevision | null;
  attempt: AttemptSnapshot;
  role: "plan" | "execute";
  baseSha: string | null;
  recoveryBundle?: RecoveryBundle;
}

export type WorkerNodeClientMessage =
  | { type: "worker.capabilities"; capabilities: WorkerNodeCapabilities }
  | { type: "worker.heartbeat"; activeAttempts: number; freeCapacity: number }
  | { type: "worker.pull"; maxItems: number }
  | {
      type: "worker.assignmentAck";
      attemptId: string;
      fence: number;
      workspace: { worktreePath: string; branch: string; baseSha: string; mirrorPath: string; sourcePath: string };
      pid: number;
    }
  | { type: "worker.event"; attemptId: string; fence: number; seq: number; eventType: string; payload: unknown }
  | {
      type: "worker.complete";
      attemptId: string;
      fence: number;
      report: WorkerWorkReport;
      planContent?: string;
      commitSha?: string;
      diff?: unknown;
      diffArtifactId?: string;
      logArtifactId?: string;
      recovered?: boolean;
    }
  | { type: "worker.fail"; attemptId: string; fence: number; error: string; retry?: boolean };

export type WorkerNodeServerMessage =
  | { type: "worker.hello"; protocolVersion: number; nodeId: string; serverTime: number }
  | { type: "worker.assignment"; assignment: WorkerAssignment }
  | { type: "worker.cancel"; attemptId: string; fence: number }
  | { type: "worker.error"; attemptId?: string; code: string; message: string };

export function isWorkerNodeClientMessage(value: unknown): value is WorkerNodeClientMessage {
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") return false;
  return (value as { type: string }).type.startsWith("worker.");
}
