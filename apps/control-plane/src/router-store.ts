import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface RouterLease {
  id: string;
  workItemId: string;
  nodeId: string;
  fence: number;
  status: string;
  expiresAt: number;
}

export class RouterStore {
  constructor(readonly db: DatabaseSync) {}

  register(id: string, baseUrl: string): void {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO routers(id, base_url, status, fence, heartbeat_at, created_at, updated_at) VALUES (?, ?, 'ACTIVE', 1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = 'ACTIVE', heartbeat_at = excluded.heartbeat_at, updated_at = excluded.updated_at",
      )
      .run(id, baseUrl, now, now, now);
  }

  heartbeat(id: string): boolean {
    return (
      this.db
        .prepare("UPDATE routers SET heartbeat_at = ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE'")
        .run(Date.now(), Date.now(), id).changes > 0
    );
  }

  offline(id: string): void {
    this.db.prepare("UPDATE routers SET status = 'OFFLINE', updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  acquireSourceLease(source: string, routerId: string, ttlMs = 15_000): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      const key = `source.lease:${source}`;
      const current = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      let owner = "";
      let fence = 0;
      let expiresAt = 0;
      if (current) {
        const value = JSON.parse(current.value) as { routerId: string; fence: number; expiresAt: number };
        owner = value.routerId;
        fence = value.fence;
        expiresAt = value.expiresAt;
      }
      if (owner && owner !== routerId && expiresAt > now) {
        this.db.exec("COMMIT");
        return false;
      }
      const nextFence = fence + 1;
      this.db
        .prepare("INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, JSON.stringify({ routerId, fence: nextFence, expiresAt: now + ttlMs }));
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renewSourceLease(source: string, routerId: string, ttlMs = 15_000): boolean {
    const key = `source.lease:${source}`;
    const current = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    if (!current) return false;
    const value = JSON.parse(current.value) as { routerId: string; fence: number; expiresAt: number };
    if (value.routerId !== routerId) return false;
    const next = JSON.stringify({ ...value, expiresAt: Date.now() + ttlMs });
    return (
      this.db.prepare("UPDATE metadata SET value = ? WHERE key = ? AND value = ?").run(next, key, current.value)
        .changes > 0
    );
  }

  releaseSourceLease(source: string, routerId: string): void {
    const key = `source.lease:${source}`;
    const current = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    if (!current) return;
    const value = JSON.parse(current.value) as { routerId: string };
    if (value.routerId === routerId) this.db.prepare("DELETE FROM metadata WHERE key = ?").run(key);
  }

  /** 以 work_items.active_attempt_id 做唯一执行资格 CAS，worker_leases 保存节点与 fence。 */
  claim(workItemId: string, nodeId: string, ttlMs = 120_000): RouterLease | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      const node = this.db.prepare("SELECT status, revoked_at FROM worker_nodes WHERE id = ?").get(nodeId) as
        | { status: string; revoked_at: number | null }
        | undefined;
      if (node?.status !== "ACTIVE" || node.revoked_at !== null) {
        this.db.exec("COMMIT");
        return null;
      }
      const id = `wl_${randomUUID()}`;
      const previous = this.db
        .prepare("SELECT COALESCE(MAX(fence), 0) AS fence FROM worker_leases WHERE work_item_id = ?")
        .get(workItemId) as { fence: number };
      const fence = previous.fence + 1;
      const updated = this.db
        .prepare(
          "UPDATE work_items SET active_attempt_id = ?, updated_at = ? WHERE id = ? AND active_attempt_id IS NULL",
        )
        .run(id, now, workItemId);
      if (updated.changes !== 1) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db
        .prepare(
          "INSERT INTO worker_leases(id, work_item_id, node_id, fence, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?)",
        )
        .run(id, workItemId, nodeId, fence, now + ttlMs, now, now);
      this.db.exec("COMMIT");
      return { id, workItemId, nodeId, fence, status: "ACTIVE", expiresAt: now + ttlMs };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renew(leaseId: string, nodeId: string, fence: number, ttlMs = 120_000): boolean {
    const now = Date.now();
    return (
      this.db
        .prepare(
          "UPDATE worker_leases SET expires_at = ?, updated_at = ? WHERE id = ? AND node_id = ? AND fence = ? AND status = 'ACTIVE'",
        )
        .run(now + ttlMs, now, leaseId, nodeId, fence).changes > 0
    );
  }

  finish(leaseId: string, nodeId: string, fence: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          "UPDATE worker_leases SET status = 'FINISHED', updated_at = ? WHERE id = ? AND node_id = ? AND fence = ? AND status = 'ACTIVE'",
        )
        .run(Date.now(), leaseId, nodeId, fence);
      if (result.changes !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare("UPDATE work_items SET active_attempt_id = NULL, updated_at = ? WHERE active_attempt_id = ?")
        .run(Date.now(), leaseId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  revokeNode(nodeId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      this.db
        .prepare("UPDATE worker_nodes SET status = 'REVOKED', revoked_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, nodeId);
      this.db
        .prepare("UPDATE worker_leases SET status = 'REVOKED', updated_at = ? WHERE node_id = ? AND status = 'ACTIVE'")
        .run(now, nodeId);
      this.db
        .prepare(
          "UPDATE work_items SET active_attempt_id = NULL, updated_at = ? WHERE active_attempt_id IN (SELECT id FROM worker_leases WHERE node_id = ? AND status = 'REVOKED')",
        )
        .run(now, nodeId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  leases(): RouterLease[] {
    return (
      this.db.prepare("SELECT * FROM worker_leases ORDER BY created_at DESC").all() as unknown as Array<
        Record<string, any>
      >
    ).map((row) => ({
      id: row.id,
      workItemId: row.work_item_id,
      nodeId: row.node_id,
      fence: row.fence,
      status: row.status,
      expiresAt: row.expires_at,
    }));
  }
}
