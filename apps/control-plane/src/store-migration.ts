import { randomUUID } from "node:crypto";
import { readJsonFile, writeFileAtomic } from "@spcode/shared/node";
import type { SqliteSuperAgentStore } from "./store-sqlite.js";

export interface StoreBackup {
  version: 1;
  schemaVersion: 6;
  exportedAt: number;
  tables: Record<string, Array<Record<string, unknown>>>;
}

const TABLES = [
  "metadata",
  "source_events",
  "digest_runs",
  "digest_items",
  "triggers",
  "threads",
  "work_items",
  "plan_revisions",
  "approvals",
  "runs",
  "attempts",
  "mailbox",
  "leases",
  "effect_requests",
  "effects",
  "effect_results",
  "outbox",
  "artifacts",
  "audit_log",
  "events",
  "repo_cursors",
  "issue_snapshots",
  "thread_events",
  "subscriptions",
  "feishu_cards",
  "watchdog_findings",
  "worker_events",
  "routers",
  "worker_nodes",
  "worker_leases",
  "recovery_bundles",
  "effect_leases",
  "share_links",
] as const;

function validateBackup(value: unknown): StoreBackup | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const backup = value as Partial<StoreBackup>;
  if (
    backup.version !== 1 ||
    backup.schemaVersion !== 6 ||
    typeof backup.exportedAt !== "number" ||
    !backup.tables ||
    typeof backup.tables !== "object"
  )
    return null;
  return backup as StoreBackup;
}

export function exportStoreBackup(store: SqliteSuperAgentStore, file: string): StoreBackup {
  const tables: StoreBackup["tables"] = {};
  for (const table of TABLES) {
    if (table === "metadata") {
      tables[table] = store.db
        .prepare("SELECT * FROM metadata WHERE key NOT LIKE 'source.lease:%'")
        .all() as unknown as Array<Record<string, unknown>>;
    } else {
      tables[table] = store.db.prepare(`SELECT * FROM ${table}`).all() as unknown as Array<Record<string, unknown>>;
    }
  }
  const backup: StoreBackup = { version: 1, schemaVersion: 6, exportedAt: Date.now(), tables };
  writeFileAtomic(file, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 });
  return backup;
}

export function readStoreBackup(file: string): StoreBackup {
  const backup = readJsonFile(file, validateBackup);
  if (!backup) throw new Error("备份格式或 schema 版本无效");
  return backup;
}

/** 单事务导入，目标库无写入方时才允许执行；身份 token/会话不迁移。 */
export function importStoreBackup(store: SqliteSuperAgentStore, backup: StoreBackup): void {
  for (const table of ["work_items", "outbox", "artifacts"] as const) {
    const row = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    if (Number(row.n) > 0) throw new Error(`目标库非空（${table}），禁止迁移覆盖或双写`);
  }
  store.db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of TABLES) {
      const rows = backup.tables[table] ?? [];
      for (const row of rows) {
        const columns = Object.keys(row);
        if (!columns.every((column) => /^[a-z_][a-z0-9_]*$/.test(column)))
          throw new Error(`备份列名非法：${table}(${columns.join(",")})`);
        const placeholders = columns.map(() => "?").join(", ");
        const sql = `INSERT INTO ${table}(${columns.join(",")}) VALUES (${placeholders})`;
        store.db.prepare(sql).run(...columns.map((column) => row[column] as never));
      }
    }
    for (const table of ["events", "audit_log", "worker_events"] as const) {
      const row = store.db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM ${table}`).get() as { id: number };
      if (store.constructor.name === "PostgresSuperAgentStore") {
        store.db
          .prepare(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST(1, ?), ? > 0)`)
          .run(row.id, row.id);
      } else if (store.db.prepare("SELECT 1 FROM sqlite_sequence WHERE name = ?").get(table)) {
        store.db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").run(row.id, table);
      }
    }
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

export function backupId(): string {
  return `backup_${randomUUID()}`;
}
