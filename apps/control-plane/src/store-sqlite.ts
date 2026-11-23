import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AuditEntry,
  PlanRevision,
  PlanStatus,
  SuperAgentCommand,
  SuperAgentSnapshot,
  WorkItem,
  WorkItemState,
} from "@spcode/shared/superagent";
import { assertPlanApproval, assertTransition } from "@spcode/superagent";
import { migrateWorkerSchema } from "./worker-store.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS source_events (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  actor_id TEXT,
  container_id TEXT,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE(source_id, external_event_id)
);
CREATE TABLE IF NOT EXISTS digest_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(schedule_id, local_date, config_version)
);
CREATE TABLE IF NOT EXISTS digest_items (
  id TEXT PRIMARY KEY,
  digest_id TEXT NOT NULL REFERENCES digest_runs(id),
  external_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  resolution TEXT,
  UNIQUE(digest_id, external_id)
);
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  source_event_id TEXT REFERENCES source_events(id),
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  repo TEXT NOT NULL,
  request_text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(source, external_id)
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  work_item_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(source, external_id)
);
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL UNIQUE REFERENCES triggers(id),
  repo TEXT NOT NULL,
  title TEXT NOT NULL,
  request_text TEXT NOT NULL,
  status TEXT NOT NULL,
  desired_state TEXT NOT NULL,
  current_plan_id TEXT,
  active_attempt_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plan_revisions (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  verification_json TEXT NOT NULL,
  change_scope_json TEXT NOT NULL,
  publish_intent INTEGER NOT NULL,
  effect_intent_json TEXT NOT NULL,
  risk TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(work_item_id, revision)
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  decision TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(subject_id, kind, actor_id)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  plan_id TEXT NOT NULL REFERENCES plan_revisions(id),
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  fence INTEGER NOT NULL,
  status TEXT NOT NULL,
  worker_pid INTEGER,
  worktree_path TEXT,
  branch TEXT,
  heartbeat_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mailbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS leases (
  owner_id TEXT PRIMARY KEY,
  fence INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS effect_requests (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  attempt_id TEXT REFERENCES attempts(id),
  type TEXT NOT NULL,
  resource TEXT NOT NULL,
  input_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  expected_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS effects (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES effect_requests(id),
  status TEXT NOT NULL,
  fence INTEGER NOT NULL,
  external_id TEXT,
  result_json TEXT,
  last_error TEXT,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS effect_results (
  id TEXT PRIMARY KEY,
  effect_id TEXT NOT NULL REFERENCES effects(id),
  observed_status TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  external_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(status, next_run_at);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  work_item_id TEXT REFERENCES work_items(id),
  storage_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  visibility TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id TEXT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_hash TEXT,
  detail_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id TEXT,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

interface WorkItemRow {
  id: string;
  trigger_id: string;
  repo: string;
  title: string;
  request_text: string;
  status: WorkItemState;
  desired_state: "ACTIVE" | "STOPPED";
  current_plan_id: string | null;
  active_attempt_id: string | null;
  created_at: number;
  updated_at: number;
  worker_session_file?: string | null;
  worktree_path?: string | null;
  branch?: string | null;
  base_sha?: string | null;
  commit_sha?: string | null;
  diff_json?: string | null;
  report_json?: string | null;
  last_error?: string | null;
}

interface PlanRow {
  id: string;
  work_item_id: string;
  revision: number;
  content: string;
  plan_hash: string;
  base_sha: string;
  verification_json: string;
  change_scope_json: string;
  publish_intent: number;
  effect_intent_json: string;
  risk: string;
  status: PlanStatus;
  created_at: number;
}

function jsonValue<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function workItemFromRow(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    triggerId: row.trigger_id,
    repo: row.repo,
    title: row.title,
    request: row.request_text,
    status: row.status,
    desiredState: row.desired_state,
    currentPlanId: row.current_plan_id,
    activeAttemptId: row.active_attempt_id,
    workerSessionFile: row.worker_session_file ?? null,
    worktreePath: row.worktree_path ?? null,
    branch: row.branch ?? null,
    baseSha: row.base_sha ?? null,
    commitSha: row.commit_sha ?? null,
    diff: jsonValue(row.diff_json),
    report: jsonValue(row.report_json),
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function jsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function planFromRow(row: PlanRow): PlanRevision {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    revision: row.revision,
    content: row.content,
    planHash: row.plan_hash,
    baseSha: row.base_sha,
    verification: jsonArray(row.verification_json),
    changeScope: jsonArray(row.change_scope_json),
    publishIntent: row.publish_intent === 1,
    effectIntent: jsonArray(row.effect_intent_json),
    risk: row.risk,
    status: row.status,
    createdAt: row.created_at,
  };
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class SqliteSuperAgentStore {
  readonly db: DatabaseSync;

  constructor(readonly file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version > 2) throw new Error(`控制面数据库版本 ${version.user_version} 高于当前程序支持的版本 2`);
    if (version.user_version === 0) {
      this.db.exec(SCHEMA);
      this.db.exec("PRAGMA user_version = 1");
    }
    migrateWorkerSchema(this.db);
  }

  close(): void {
    this.db.close();
  }

  snapshot(): Omit<SuperAgentSnapshot, "service" | "enabled"> {
    const workItems = (
      this.db
        .prepare(
          `SELECT * FROM work_items ORDER BY CASE status
            WHEN 'AWAITING_PLAN_APPROVAL' THEN 0 WHEN 'AWAITING_RECONCILIATION' THEN 1
            WHEN 'BLOCKED' THEN 2 WHEN 'RUNNING' THEN 3 WHEN 'QUEUED' THEN 4
            ELSE 5 END, updated_at DESC LIMIT 500`,
        )
        .all() as unknown as WorkItemRow[]
    ).map(workItemFromRow);
    const plans = (
      this.db.prepare("SELECT * FROM plan_revisions ORDER BY created_at DESC LIMIT 500").all() as unknown as PlanRow[]
    ).map(planFromRow);
    const auditRows = this.db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 300").all() as unknown as Array<{
      id: number;
      work_item_id: string | null;
      actor_id: string;
      action: string;
      subject_hash: string | null;
      detail_json: string;
      created_at: number;
    }>;
    const audit: AuditEntry[] = auditRows.map((row) => ({
      id: row.id,
      workItemId: row.work_item_id,
      actorId: row.actor_id,
      action: row.action,
      subjectHash: row.subject_hash,
      detail: this.parseDetail(row.detail_json),
      createdAt: row.created_at,
    }));
    const attempts = this.db
      .prepare("SELECT * FROM attempts ORDER BY created_at DESC LIMIT 200")
      .all() as unknown as Array<Record<string, any>>;
    return {
      revision: this.revision(),
      workItems,
      plans,
      attempts: attempts.map((row) => ({
        id: row.id,
        runId: row.run_id,
        workItemId: row.work_item_id,
        fence: row.fence,
        role: row.role,
        status: row.status,
        workerPid: row.worker_pid,
        worktreePath: row.worktree_path,
        branch: row.branch,
        heartbeatAt: row.heartbeat_at,
        leaseExpiresAt: row.lease_expires_at,
        report: jsonValue(row.report_json),
        lastError: row.last_error,
        lastEventSeq: row.last_event_seq,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      audit,
    };
  }

  processingPaused(): boolean {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key = 'processingPaused'").get() as
      | { value: string }
      | undefined;
    return row?.value === "true";
  }

  execute(command: SuperAgentCommand, actorId: string): { eventId: number; workItemId?: string } {
    return this.transaction(() => {
      switch (command.type) {
        case "workitem.create":
          return this.createWorkItem(command, actorId);
        case "plan.submit":
          return this.submitPlan(command, actorId);
        case "plan.approve":
          return this.approvePlan(command, actorId);
        case "workitem.cancel":
          return this.cancelWorkItem(command.workItemId, actorId);
        case "workitem.retry":
          return this.retryWorkItem(command.workItemId, actorId);
        case "processing.setPaused": {
          this.db
            .prepare(
              "INSERT INTO metadata(key, value) VALUES ('processingPaused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .run(String(command.paused));
          const eventId = this.recordEvent(null, command.type);
          this.recordAudit(null, actorId, command.type, null, { paused: command.paused });
          return { eventId };
        }
      }
    });
  }

  private createWorkItem(
    command: Extract<SuperAgentCommand, { type: "workitem.create" }>,
    actorId: string,
  ): { eventId: number; workItemId: string } {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(command.repo)) throw new Error("仓库必须使用 owner/repo 格式");
    const payloadHash = hashPayload({ repo: command.repo, title: command.title, request: command.request });
    const existing = this.db
      .prepare("SELECT id, payload_hash FROM triggers WHERE source = 'local-web' AND external_id = ?")
      .get(command.requestId) as { id: string; payload_hash: string } | undefined;
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw new Error("相同 requestId 已用于不同内容");
      const item = this.db.prepare("SELECT id FROM work_items WHERE trigger_id = ?").get(existing.id) as { id: string };
      return { eventId: this.revision(), workItemId: item.id };
    }
    const now = Date.now();
    const triggerId = `tr_${randomUUID()}`;
    const workItemId = `wi_${randomUUID()}`;
    const sourceEventId = `se_${randomUUID()}`;
    this.db
      .prepare(
        "INSERT INTO source_events(id, source_id, external_event_id, actor_id, payload_hash, payload_json, received_at) VALUES (?, 'local-web', ?, ?, ?, ?, ?)",
      )
      .run(sourceEventId, command.requestId, actorId, payloadHash, JSON.stringify(command), now);
    this.db
      .prepare(
        "INSERT INTO triggers(id, source_event_id, source, external_id, payload_hash, repo, request_text, created_at) VALUES (?, ?, 'local-web', ?, ?, ?, ?, ?)",
      )
      .run(triggerId, sourceEventId, command.requestId, payloadHash, command.repo, command.request, now);
    this.db
      .prepare(
        "INSERT INTO work_items(id, trigger_id, repo, title, request_text, status, desired_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'PLANNING', 'ACTIVE', ?, ?)",
      )
      .run(workItemId, triggerId, command.repo, command.title, command.request, now, now);
    this.db
      .prepare(
        "INSERT INTO threads(id, source, external_id, work_item_id, created_at) VALUES (?, 'local-web', ?, ?, ?)",
      )
      .run(`th_${randomUUID()}`, workItemId, workItemId, now);
    const eventId = this.recordEvent(workItemId, command.type);
    this.recordAudit(workItemId, actorId, command.type, payloadHash, { repo: command.repo });
    return { eventId, workItemId };
  }

  private submitPlan(
    command: Extract<SuperAgentCommand, { type: "plan.submit" }>,
    actorId: string,
  ): { eventId: number; workItemId: string } {
    const item = this.getWorkItem(command.workItemId);
    if (item.status !== "PLANNING" && item.status !== "AWAITING_PLAN_APPROVAL") {
      throw new Error("当前状态不能提交新计划");
    }
    const now = Date.now();
    const planId = `pl_${randomUUID()}`;
    const revision = (
      this.db
        .prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM plan_revisions WHERE work_item_id = ?")
        .get(item.id) as {
        next: number;
      }
    ).next;
    const planHash = hashPayload({
      workItemId: item.id,
      revision,
      content: command.content,
      baseSha: command.baseSha,
      verification: command.verification,
      changeScope: command.changeScope,
      publishIntent: command.publishIntent === true,
      effectIntent: command.effectIntent ?? [],
      risk: command.risk ?? "",
    });
    this.db
      .prepare(
        "UPDATE plan_revisions SET status = 'SUPERSEDED' WHERE work_item_id = ? AND status IN ('PENDING', 'APPROVED')",
      )
      .run(item.id);
    this.db
      .prepare(
        `INSERT INTO plan_revisions(id, work_item_id, revision, content, plan_hash, base_sha, verification_json,
          change_scope_json, publish_intent, effect_intent_json, risk, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      )
      .run(
        planId,
        item.id,
        revision,
        command.content,
        planHash,
        command.baseSha,
        JSON.stringify(command.verification),
        JSON.stringify(command.changeScope),
        command.publishIntent === true ? 1 : 0,
        JSON.stringify(command.effectIntent ?? []),
        command.risk ?? "",
        now,
      );
    this.db
      .prepare(
        "UPDATE work_items SET status = 'AWAITING_PLAN_APPROVAL', current_plan_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(planId, now, item.id);
    this.db
      .prepare("INSERT INTO mailbox(work_item_id, kind, payload_json, created_at) VALUES (?, 'plan.pending', ?, ?)")
      .run(item.id, JSON.stringify({ planId, planHash }), now);
    const eventId = this.recordEvent(item.id, command.type);
    this.recordAudit(item.id, actorId, command.type, planHash, { planId, revision, baseSha: command.baseSha });
    return { eventId, workItemId: item.id };
  }

  private approvePlan(
    command: Extract<SuperAgentCommand, { type: "plan.approve" }>,
    actorId: string,
  ): { eventId: number; workItemId: string } {
    const item = this.getWorkItem(command.workItemId);
    const row = this.db.prepare("SELECT * FROM plan_revisions WHERE id = ?").get(command.planId) as PlanRow | undefined;
    if (!row) throw new Error("计划不存在");
    const plan = planFromRow(row);
    if (
      item.currentPlanId === plan.id &&
      item.status !== "PLANNING" &&
      item.status !== "AWAITING_PLAN_APPROVAL" &&
      plan.status === "APPROVED" &&
      plan.planHash === command.planHash &&
      plan.workItemId === item.id
    ) {
      return { eventId: this.revision(), workItemId: item.id };
    }
    assertPlanApproval({
      actorId,
      authorized: actorId === "local-device",
      workItem: item,
      plan,
      presentedPlanHash: command.planHash,
    });
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO approvals(id, subject_id, subject_hash, kind, actor_id, policy_version, decision, created_at) VALUES (?, ?, ?, 'PLAN_EXECUTE', ?, 1, 'APPROVED', ?)",
      )
      .run(`ap_${randomUUID()}`, plan.id, plan.planHash, actorId, now);
    this.db.prepare("UPDATE plan_revisions SET status = 'APPROVED' WHERE id = ?").run(plan.id);
    this.db
      .prepare("INSERT INTO runs(id, work_item_id, plan_id, status, created_at) VALUES (?, ?, ?, 'QUEUED', ?)")
      .run(`run_${randomUUID()}`, item.id, plan.id, now);
    this.db
      .prepare(
        "INSERT INTO mailbox(work_item_id, kind, payload_json, created_at) VALUES (?, 'execution.dispatch', ?, ?)",
      )
      .run(item.id, JSON.stringify({ planId: plan.id, planHash: plan.planHash }), now);
    this.db.prepare("UPDATE work_items SET status = 'QUEUED', updated_at = ? WHERE id = ?").run(now, item.id);
    const eventId = this.recordEvent(item.id, command.type);
    this.recordAudit(item.id, actorId, command.type, plan.planHash, { planId: plan.id, runCreated: true });
    return { eventId, workItemId: item.id };
  }

  private cancelWorkItem(workItemId: string, actorId: string): { eventId: number; workItemId: string } {
    const item = this.getWorkItem(workItemId);
    if (item.status === "CANCELLED") return { eventId: this.revision(), workItemId };
    if (item.status === "COMPLETED") throw new Error("已完成 WorkItem 不能取消");
    assertTransition(item.status, "CANCELLED");
    const now = Date.now();
    this.db
      .prepare("UPDATE work_items SET status = 'CANCELLED', desired_state = 'STOPPED', updated_at = ? WHERE id = ?")
      .run(now, workItemId);
    this.db
      .prepare(
        "UPDATE attempts SET status = 'CANCELLED', updated_at = ? WHERE work_item_id = ? AND status != 'COMPLETED'",
      )
      .run(now, workItemId);
    const eventId = this.recordEvent(workItemId, "workitem.cancel");
    this.recordAudit(workItemId, actorId, "workitem.cancel", null, { previousStatus: item.status });
    return { eventId, workItemId };
  }

  private retryWorkItem(workItemId: string, actorId: string): { eventId: number; workItemId: string } {
    const item = this.getWorkItem(workItemId);
    if (item.status !== "FAILED" && item.status !== "BLOCKED") throw new Error("只有失败或阻塞的 WorkItem 可以重试");
    if (!item.currentPlanId) throw new Error("没有已批准计划，不能重试");
    const plan = this.db.prepare("SELECT status FROM plan_revisions WHERE id = ?").get(item.currentPlanId) as
      | { status: PlanStatus }
      | undefined;
    if (plan?.status !== "APPROVED") throw new Error("当前计划未获批准");
    assertTransition(item.status, "QUEUED");
    const now = Date.now();
    this.db
      .prepare("UPDATE work_items SET status = 'QUEUED', desired_state = 'ACTIVE', updated_at = ? WHERE id = ?")
      .run(now, workItemId);
    this.db
      .prepare("INSERT INTO mailbox(work_item_id, kind, payload_json, created_at) VALUES (?, 'execution.retry', ?, ?)")
      .run(workItemId, JSON.stringify({ planId: item.currentPlanId }), now);
    const eventId = this.recordEvent(workItemId, "workitem.retry");
    this.recordAudit(workItemId, actorId, "workitem.retry", null, { previousStatus: item.status });
    return { eventId, workItemId };
  }

  private getWorkItem(id: string): WorkItem {
    const row = this.db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as WorkItemRow | undefined;
    if (!row) throw new Error("WorkItem 不存在");
    return workItemFromRow(row);
  }

  private revision(): number {
    return (this.db.prepare("SELECT COALESCE(MAX(id), 0) AS revision FROM events").get() as { revision: number })
      .revision;
  }

  private recordEvent(workItemId: string | null, type: string): number {
    const result = this.db
      .prepare("INSERT INTO events(work_item_id, type, created_at) VALUES (?, ?, ?)")
      .run(workItemId, type, Date.now());
    return Number(result.lastInsertRowid);
  }

  private recordAudit(
    workItemId: string | null,
    actorId: string,
    action: string,
    subjectHash: string | null,
    detail: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        "INSERT INTO audit_log(work_item_id, actor_id, action, subject_hash, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(workItemId, actorId, action, subjectHash, JSON.stringify(detail), Date.now());
  }

  private parseDetail(value: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
