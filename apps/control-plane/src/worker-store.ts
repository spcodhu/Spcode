import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AttemptSnapshot, WorkerRole, WorkerWorkReport, WorkItem, WorkItemState } from "@spcode/shared/superagent";
import { assertTransition } from "@spcode/superagent";
import type { GitDiffSnapshot, GitWorkspace } from "./git-workspace.js";

export interface ManagedWorkItem extends WorkItem {
  workerSessionFile: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseSha: string | null;
  commitSha: string | null;
  diff: GitDiffSnapshot | null;
  report: WorkerWorkReport | null;
  lastError: string | null;
}

interface ItemRow {
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
  worker_session_file: string | null;
  worktree_path: string | null;
  branch: string | null;
  base_sha: string | null;
  commit_sha: string | null;
  diff_json: string | null;
  report_json: string | null;
  last_error: string | null;
}

interface AttemptRow {
  id: string;
  run_id: string | null;
  work_item_id: string;
  fence: number;
  role: WorkerRole;
  status: string;
  worker_pid: number | null;
  worktree_path: string | null;
  branch: string | null;
  heartbeat_at: number | null;
  lease_expires_at: number | null;
  report_json: string | null;
  last_error: string | null;
  last_event_seq: number;
  created_at: number;
  updated_at: number;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function itemFromRow(row: ItemRow): ManagedWorkItem {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    workerSessionFile: row.worker_session_file,
    worktreePath: row.worktree_path,
    branch: row.branch,
    baseSha: row.base_sha,
    commitSha: row.commit_sha,
    diff: parseJson(row.diff_json),
    report: parseJson(row.report_json),
    lastError: row.last_error,
  };
}

function attemptFromRow(row: AttemptRow): AttemptSnapshot {
  return {
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
    report: parseJson(row.report_json),
    lastError: row.last_error,
    lastEventSeq: row.last_event_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** v1 只有审批，没有任何真实 Attempt；v2 重建 attempts 以允许 planning.run_id=NULL。 */
export function migrateWorkerSchema(db: DatabaseSync): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version >= 2) return;
  if (version < 1) throw new Error("基础控制面 schema 尚未初始化");
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const [name, type] of [
      ["worker_session_file", "TEXT"],
      ["worktree_path", "TEXT"],
      ["branch", "TEXT"],
      ["base_sha", "TEXT"],
      ["commit_sha", "TEXT"],
      ["diff_json", "TEXT"],
      ["report_json", "TEXT"],
      ["last_error", "TEXT"],
    ] as const) {
      db.exec(`ALTER TABLE work_items ADD COLUMN ${name} ${type}`);
    }
    db.exec(`
      CREATE TABLE attempts_v2 (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(id),
        work_item_id TEXT NOT NULL REFERENCES work_items(id),
        fence INTEGER NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        worker_pid INTEGER,
        worktree_path TEXT,
        branch TEXT,
        heartbeat_at INTEGER,
        lease_expires_at INTEGER,
        report_json TEXT,
        last_error TEXT,
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO attempts_v2(id, run_id, work_item_id, fence, role, status, worker_pid, worktree_path, branch,
        heartbeat_at, created_at, updated_at)
        SELECT id, run_id, work_item_id, fence, 'execute', status, worker_pid, worktree_path, branch,
          heartbeat_at, created_at, updated_at FROM attempts;
      DROP TABLE attempts;
      ALTER TABLE attempts_v2 RENAME TO attempts;
      CREATE INDEX attempts_active_idx ON attempts(work_item_id, status);
      CREATE TABLE worker_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        work_item_id TEXT NOT NULL REFERENCES work_items(id),
        fence INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(attempt_id, seq)
      );
      CREATE INDEX worker_events_item_idx ON worker_events(work_item_id, id);
      PRAGMA user_version = 2;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

export class WorkerStore {
  constructor(
    readonly db: DatabaseSync,
    private readonly publish: (sequence: number, workItemId?: string) => void,
  ) {}

  getItem(id: string): ManagedWorkItem {
    const row = this.db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as ItemRow | undefined;
    if (!row) throw new Error("WorkItem 不存在");
    return itemFromRow(row);
  }

  getAttempt(id: string): AttemptSnapshot {
    const row = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as AttemptRow | undefined;
    if (!row) throw new Error("Attempt 不存在");
    return attemptFromRow(row);
  }

  listAttempts(limit = 200): AttemptSnapshot[] {
    return (
      this.db.prepare("SELECT * FROM attempts ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as AttemptRow[]
    ).map(attemptFromRow);
  }

  listActiveAttempts(): AttemptSnapshot[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM attempts WHERE status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'RECOVERED') ORDER BY created_at",
        )
        .all() as unknown as AttemptRow[]
    ).map(attemptFromRow);
  }

  listDispatchable(): ManagedWorkItem[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM work_items WHERE desired_state = 'ACTIVE' AND active_attempt_id IS NULL AND (
            (status = 'PLANNING' AND current_plan_id IS NULL) OR status = 'QUEUED'
          ) ORDER BY created_at LIMIT 20`,
        )
        .all() as unknown as ItemRow[]
    ).map(itemFromRow);
  }

  startAttempt(workItemId: string, role: WorkerRole): AttemptSnapshot {
    const id = this.changed(workItemId, "attempt.start", (now) => {
      const item = this.getItem(workItemId);
      if (item.activeAttemptId || item.desiredState !== "ACTIVE") throw new Error("WorkItem 已有活跃 Attempt 或已停止");
      if (role === "plan" && (item.status !== "PLANNING" || item.currentPlanId))
        throw new Error("当前不需要计划 Attempt");
      if (role === "execute" && (item.status !== "QUEUED" || !item.currentPlanId))
        throw new Error("当前不需要执行 Attempt");
      const run =
        role === "execute"
          ? (this.db
              .prepare("SELECT id FROM runs WHERE work_item_id = ? AND plan_id = ? ORDER BY created_at DESC LIMIT 1")
              .get(item.id, item.currentPlanId) as { id: string } | undefined)
          : null;
      if (role === "execute" && !run) throw new Error("已批准计划缺少 Run");
      const previous = this.db
        .prepare("SELECT COALESCE(MAX(fence), 0) AS fence FROM attempts WHERE work_item_id = ?")
        .get(item.id) as { fence: number };
      const fence = previous.fence + 1;
      const id = `at_${randomUUID()}`;
      const leaseExpiresAt = now + 120_000;
      this.db
        .prepare(
          `INSERT INTO attempts(id, run_id, work_item_id, fence, role, status, heartbeat_at, lease_expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'STARTING', ?, ?, ?, ?)`,
        )
        .run(id, run?.id ?? null, item.id, fence, role, now, leaseExpiresAt, now, now);
      this.db
        .prepare(
          `INSERT INTO leases(owner_id, fence, expires_at, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(owner_id) DO UPDATE SET fence = excluded.fence, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
        )
        .run(item.id, fence, leaseExpiresAt, now);
      this.db
        .prepare(
          "UPDATE work_items SET active_attempt_id = ?, status = ?, updated_at = ?, last_error = NULL WHERE id = ?",
        )
        .run(id, role === "execute" ? "RUNNING" : item.status, now, item.id);
      return id;
    });
    return this.getAttempt(id);
  }

  attachWorker(attemptId: string, fence: number, pid: number, workspace: GitWorkspace): void {
    const attempt = this.getAttempt(attemptId);
    this.changed(attempt.workItemId, "attempt.attach", (now) => {
      this.assertFence(attemptId, fence);
      this.db
        .prepare(
          `UPDATE attempts SET worker_pid = ?, status = 'RUNNING', worktree_path = ?, branch = ?, heartbeat_at = ?,
            lease_expires_at = ?, updated_at = ? WHERE id = ? AND fence = ?`,
        )
        .run(pid, workspace.worktreePath, workspace.branch, now, now + 120_000, now, attemptId, fence);
      this.db
        .prepare(
          `UPDATE work_items SET worktree_path = ?, branch = ?, base_sha = ?, updated_at = ? WHERE id = ? AND active_attempt_id = ?`,
        )
        .run(workspace.worktreePath, workspace.branch, workspace.baseSha, now, attempt.workItemId, attemptId);
      this.touchLease(attempt.workItemId, fence, now);
    });
  }

  saveSessionFile(attemptId: string, fence: number, sessionFile: string): void {
    const attempt = this.getAttempt(attemptId);
    this.changed(attempt.workItemId, "attempt.session", (now) => {
      this.assertFence(attemptId, fence);
      this.db
        .prepare("UPDATE work_items SET worker_session_file = ?, updated_at = ? WHERE id = ?")
        .run(sessionFile, now, attempt.workItemId);
    });
  }

  heartbeat(attemptId: string, fence: number): boolean {
    const attempt = this.getAttempt(attemptId);
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE attempts SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND fence = ? AND status = 'RUNNING'
           AND EXISTS (SELECT 1 FROM work_items w WHERE w.id = attempts.work_item_id AND w.active_attempt_id = attempts.id)
           AND EXISTS (SELECT 1 FROM leases l WHERE l.owner_id = attempts.work_item_id AND l.fence = attempts.fence)`,
      )
      .run(now, now + 120_000, now, attemptId, fence);
    if (result.changes === 0) return false;
    this.touchLease(attempt.workItemId, fence, now);
    return true;
  }

  appendEvent(attemptId: string, fence: number, seq: number, type: string, payload: unknown): boolean {
    const attempt = this.getAttempt(attemptId);
    if (!Number.isSafeInteger(seq) || seq <= attempt.lastEventSeq || attempt.fence !== fence) return false;
    try {
      return this.changed(attempt.workItemId, "worker.event", (now) => {
        this.assertFence(attemptId, fence);
        this.db
          .prepare(
            "INSERT INTO worker_events(attempt_id, work_item_id, fence, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(attemptId, attempt.workItemId, fence, seq, type, JSON.stringify(payload ?? null), now);
        this.db
          .prepare("UPDATE attempts SET last_event_seq = ?, heartbeat_at = ?, updated_at = ? WHERE id = ?")
          .run(seq, now, now, attemptId);
        this.touchLease(attempt.workItemId, fence, now);
        return true;
      });
    } catch {
      return false;
    }
  }

  recordReport(attemptId: string, fence: number, report: WorkerWorkReport): void {
    const attempt = this.getAttempt(attemptId);
    this.changed(attempt.workItemId, "worker.report", (now) => {
      this.assertFence(attemptId, fence);
      this.db
        .prepare("UPDATE attempts SET report_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(report), now, attemptId);
      this.db
        .prepare("UPDATE work_items SET report_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(report), now, attempt.workItemId);
    });
  }

  setStatus(attemptId: string, fence: number, status: WorkItemState, error?: string): void {
    const attempt = this.getAttempt(attemptId);
    this.changed(attempt.workItemId, "workitem.status", (now) => {
      this.assertFence(attemptId, fence);
      const item = this.getItem(attempt.workItemId);
      if (item.status !== status) assertTransition(item.status, status);
      this.db
        .prepare("UPDATE work_items SET status = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(status, error ?? null, now, item.id);
      if (attempt.runId) this.db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, attempt.runId);
    });
  }

  finishAttempt(attemptId: string, fence: number, status: "COMPLETED" | "FAILED" | "CANCELLED" | "RECOVERED"): void {
    const attempt = this.getAttempt(attemptId);
    this.changed(attempt.workItemId, "attempt.finish", (now) => {
      this.assertFence(attemptId, fence);
      this.db.prepare("UPDATE attempts SET status = ?, updated_at = ? WHERE id = ?").run(status, now, attemptId);
      this.db
        .prepare(
          "UPDATE work_items SET active_attempt_id = NULL, updated_at = ? WHERE id = ? AND active_attempt_id = ?",
        )
        .run(now, attempt.workItemId, attemptId);
      this.db.prepare("DELETE FROM leases WHERE owner_id = ? AND fence = ?").run(attempt.workItemId, fence);
    });
  }

  completeCommit(
    attemptId: string,
    fence: number,
    commitSha: string,
    diff: GitDiffSnapshot,
    report: WorkerWorkReport,
  ): void {
    const attempt = this.getAttempt(attemptId);
    this.changed(attempt.workItemId, "workitem.completed", (now) => {
      this.assertFence(attemptId, fence);
      const item = this.getItem(attempt.workItemId);
      if (item.commitSha && item.commitSha !== commitSha) throw new Error("WorkItem 已记录不同 commit，必须对账");
      if (item.status !== "COMMITTING" && item.status !== "RECOVERING" && item.status !== "AWAITING_RECONCILIATION") {
        throw new Error(`当前状态 ${item.status} 不能登记 commit`);
      }
      if (item.status === "COMMITTING") assertTransition(item.status, "COMPLETED");
      this.db
        .prepare(
          `UPDATE work_items SET status = 'COMPLETED', commit_sha = ?, diff_json = ?, report_json = ?, active_attempt_id = NULL,
            last_error = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(commitSha, JSON.stringify(diff), JSON.stringify(report), now, item.id);
      this.db
        .prepare("UPDATE attempts SET status = 'COMPLETED', report_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(report), now, attemptId);
      if (attempt.runId) this.db.prepare("UPDATE runs SET status = 'COMPLETED' WHERE id = ?").run(attempt.runId);
      this.db.prepare("DELETE FROM leases WHERE owner_id = ? AND fence = ?").run(item.id, fence);
    });
  }

  releasePlanningAfterCrash(attemptId: string): void {
    const attempt = this.getAttempt(attemptId);
    this.changed(attempt.workItemId, "attempt.recoverPlanning", (now) => {
      this.db.prepare("UPDATE attempts SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(now, attemptId);
      this.db
        .prepare("UPDATE work_items SET active_attempt_id = NULL, status = 'PLANNING', updated_at = ? WHERE id = ?")
        .run(now, attempt.workItemId);
      this.db.prepare("DELETE FROM leases WHERE owner_id = ?").run(attempt.workItemId);
    });
  }

  markExecutionRecovering(attemptId: string): void {
    const attempt = this.getAttempt(attemptId);
    this.changed(attempt.workItemId, "attempt.recovering", (now) => {
      const item = this.getItem(attempt.workItemId);
      if (item.status !== "RECOVERING" && item.status !== "AWAITING_RECONCILIATION")
        assertTransition(item.status, "RECOVERING");
      this.db.prepare("UPDATE attempts SET status = 'RECOVERING', updated_at = ? WHERE id = ?").run(now, attemptId);
      this.db.prepare("UPDATE work_items SET status = 'RECOVERING', updated_at = ? WHERE id = ?").run(now, item.id);
    });
  }

  finishReconciliation(attemptId: string, outcome: { status: "clean-base" | "unknown"; detail: string }): void {
    const attempt = this.getAttempt(attemptId);
    this.changed(attempt.workItemId, "attempt.reconciled", (now) => {
      const status: WorkItemState = outcome.status === "clean-base" ? "QUEUED" : "AWAITING_RECONCILIATION";
      this.db
        .prepare("UPDATE attempts SET status = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(outcome.status === "clean-base" ? "RECOVERED" : "FAILED", outcome.detail, now, attemptId);
      this.db
        .prepare(
          "UPDATE work_items SET status = ?, active_attempt_id = NULL, last_error = ?, updated_at = ? WHERE id = ?",
        )
        .run(status, outcome.detail, now, attempt.workItemId);
      this.db.prepare("DELETE FROM leases WHERE owner_id = ?").run(attempt.workItemId);
    });
  }

  workerEvents(
    workItemId: string,
    limit = 300,
  ): Array<{ id: number; seq: number; type: string; payload: unknown; createdAt: number }> {
    const rows = this.db
      .prepare("SELECT * FROM worker_events WHERE work_item_id = ? ORDER BY id DESC LIMIT ?")
      .all(workItemId, limit) as unknown as Array<{
      id: number;
      seq: number;
      type: string;
      payload_json: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      seq: row.seq,
      type: row.type,
      payload: parseJson(row.payload_json),
      createdAt: row.created_at,
    }));
  }

  private assertFence(attemptId: string, fence: number): void {
    const row = this.db
      .prepare(
        `SELECT a.fence, a.work_item_id, w.active_attempt_id, l.fence AS lease_fence
         FROM attempts a JOIN work_items w ON w.id = a.work_item_id
         LEFT JOIN leases l ON l.owner_id = a.work_item_id WHERE a.id = ?`,
      )
      .get(attemptId) as
      | { fence: number; work_item_id: string; active_attempt_id: string | null; lease_fence: number | null }
      | undefined;
    if (!row || row.fence !== fence || row.active_attempt_id !== attemptId || row.lease_fence !== fence) {
      throw new Error("stale fence：旧 Worker 无权继续写入");
    }
  }

  private touchLease(workItemId: string, fence: number, now: number): void {
    this.db
      .prepare("UPDATE leases SET expires_at = ?, updated_at = ? WHERE owner_id = ? AND fence = ?")
      .run(now + 120_000, now, workItemId, fence);
  }

  private changed<T>(workItemId: string, action: string, run: (now: number) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    let eventId: number;
    let value: T;
    try {
      const now = Date.now();
      value = run(now);
      const event = this.db
        .prepare("INSERT INTO events(work_item_id, type, created_at) VALUES (?, ?, ?)")
        .run(workItemId, action, now);
      eventId = Number(event.lastInsertRowid);
      this.db
        .prepare(
          "INSERT INTO audit_log(work_item_id, actor_id, action, detail_json, created_at) VALUES (?, 'worker-manager', ?, '{}', ?)",
        )
        .run(workItemId, action, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.publish(eventId, workItemId);
    return value;
  }
}
