import type { DatabaseSync } from "node:sqlite";

export function migratePhase2Schema(db: DatabaseSync): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version > 6) throw new Error(`控制面数据库版本 ${version} 高于当前程序支持的版本 6`);
  if (version >= 6) return;
  if (version !== 5) throw new Error("Phase 2 schema 需要从 v5 迁移");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE identity_sessions (
        token_hash TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        roles_json TEXT NOT NULL,
        issuer TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX identity_expiry_idx ON identity_sessions(expires_at);
      CREATE TABLE routers (
        id TEXT PRIMARY KEY,
        base_url TEXT NOT NULL,
        status TEXT NOT NULL,
        fence INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE worker_nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        protocol_version INTEGER NOT NULL,
        capabilities_json TEXT NOT NULL,
        status TEXT NOT NULL,
        last_heartbeat_at INTEGER,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE worker_leases (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(id),
        attempt_id TEXT REFERENCES attempts(id),
        node_id TEXT NOT NULL REFERENCES worker_nodes(id),
        fence INTEGER NOT NULL,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(work_item_id, node_id, fence)
      );
      CREATE INDEX worker_lease_active_idx ON worker_leases(status, expires_at);
      CREATE TABLE recovery_bundles (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(id),
        attempt_id TEXT REFERENCES attempts(id),
        bundle_hash TEXT NOT NULL,
        snapshot_version INTEGER NOT NULL,
        fence INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(work_item_id, bundle_hash, fence)
      );
      CREATE TABLE effect_leases (
        id TEXT PRIMARY KEY,
        effect_id TEXT NOT NULL REFERENCES effects(id),
        executor_id TEXT NOT NULL,
        fence INTEGER NOT NULL,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(effect_id, executor_id, fence)
      );
      CREATE TABLE share_links (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        token_hash TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX share_artifact_idx ON share_links(artifact_id, expires_at, revoked_at);
      PRAGMA user_version = 6;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
