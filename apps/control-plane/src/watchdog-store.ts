import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WatchdogFinding } from "@spcode/shared/superagent";

export function migrateWatchdogSchema(db: DatabaseSync): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version >= 5) return;
  if (version !== 4) throw new Error("Watchdog schema 需要从 v4 迁移");
  db.exec(`
    CREATE TABLE watchdog_findings (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      status TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      resolved_at INTEGER,
      UNIQUE(type, subject_id, status)
    );
    CREATE INDEX watchdog_open_idx ON watchdog_findings(status, last_seen_at);
    PRAGMA user_version = 5;
  `);
}

export class WatchdogStore {
  constructor(readonly db: DatabaseSync) {}

  open(type: string, subjectId: string, evidence: Record<string, unknown>, workItemId?: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO watchdog_findings(id, type, subject_id, status, evidence_json, created_at, last_seen_at)
         VALUES (?, ?, ?, 'OPEN', ?, ?, ?)
         ON CONFLICT(type, subject_id, status) DO UPDATE SET evidence_json = excluded.evidence_json, last_seen_at = excluded.last_seen_at`,
      )
      .run(`wd_${randomUUID()}`, type, subjectId, JSON.stringify(evidence), now, now);
    this.db
      .prepare("INSERT INTO events(work_item_id, type, created_at) VALUES (?, 'watchdog.finding', ?)")
      .run(workItemId ?? null, now);
  }

  resolve(type: string, subjectId: string): void {
    this.db
      .prepare(
        "UPDATE watchdog_findings SET status = 'RESOLVED', resolved_at = ? WHERE type = ? AND subject_id = ? AND status = 'OPEN'",
      )
      .run(Date.now(), type, subjectId);
  }

  list(openOnly = true): WatchdogFinding[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM watchdog_findings ${openOnly ? "WHERE status = 'OPEN'" : ""} ORDER BY last_seen_at DESC LIMIT 200`,
      )
      .all() as unknown as Array<Record<string, any>>;
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      subjectId: row.subject_id,
      status: row.status,
      evidence: JSON.parse(row.evidence_json),
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      resolvedAt: row.resolved_at,
    }));
  }
}
