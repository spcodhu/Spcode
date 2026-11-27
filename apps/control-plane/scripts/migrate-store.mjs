import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  exportStoreBackup,
  importStoreBackup,
  PostgresSuperAgentStore,
  readStoreBackup,
  SqliteSuperAgentStore,
} from "../dist/api.mjs";

const direction = process.env.SPCODE_MIGRATE_DIRECTION;
const backupFile = process.env.SPCODE_MIGRATE_BACKUP;
if (!backupFile) throw new Error("SPCODE_MIGRATE_BACKUP 必填（0600 JSON 文件路径）");

if (direction === "export") {
  const sqliteFile = process.env.SPCODE_MIGRATE_FROM_SQLITE;
  if (!sqliteFile) throw new Error("导出需要 SPCODE_MIGRATE_FROM_SQLITE");
  const store = new SqliteSuperAgentStore(resolve(sqliteFile));
  try {
    const backup = exportStoreBackup(store, resolve(backupFile));
    console.log(`MIGRATE_EXPORT_OK schema=${backup.schemaVersion} file=${backupFile}`);
  } finally {
    store.close();
  }
} else if (direction === "import") {
  const connectionString = process.env.SPCODE_POSTGRES_URL;
  if (!connectionString) throw new Error("导入需要 SPCODE_POSTGRES_URL");
  const store = new PostgresSuperAgentStore({
    connectionString,
    baseDir: process.env.SPCODE_MIGRATE_ARTIFACT_DIR ?? resolve("artifacts"),
    workerFile: pathToFileURL(resolve("apps/control-plane/dist/postgres-sync-worker.mjs")),
  });
  try {
    importStoreBackup(store, readStoreBackup(resolve(backupFile)));
    console.log("MIGRATE_IMPORT_OK");
  } finally {
    store.close();
  }
} else {
  throw new Error("SPCODE_MIGRATE_DIRECTION 必须是 export 或 import");
}
