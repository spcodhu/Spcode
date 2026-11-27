import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { afterEach, describe, expect, it } from "vitest";
import { RouterStore } from "../src/router-store.js";
import { exportStoreBackup, importStoreBackup, readStoreBackup } from "../src/store-migration.js";
import { PostgresSuperAgentStore } from "../src/store-postgres.js";
import { SqliteSuperAgentStore } from "../src/store-sqlite.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "spcode-router-pg-"));
  const pg = new EmbeddedPostgres({
    databaseDir: join(home, "pg"),
    port: 55433,
    user: "postgres",
    password: "test",
    persistent: false,
    autoRehydrateSymlinks: true,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  cleanups.push(async () => {
    await pg.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const options = {
    connectionString: "postgresql://postgres:test@127.0.0.1:55433/postgres",
    baseDir: join(home, "artifacts"),
    workerFile: new URL("../dist/postgres-sync-worker.mjs", import.meta.url),
  };
  return { home, pg, options };
}

describe("多 Router CAS 与 PostgreSQL 迁移", () => {
  it("同一 Source/WorkItem 只有一个赢家，旧 lease 与 revoked node 被拒绝", async () => {
    const { options } = await fixture();
    const first = new PostgresSuperAgentStore(options);
    const second = new PostgresSuperAgentStore(options);
    cleanups.push(
      () => first.close(),
      () => second.close(),
    );
    const routerA = new RouterStore(first.db);
    const routerB = new RouterStore(second.db);
    routerA.register("router-a", "http://127.0.0.1:1");
    routerB.register("router-b", "http://127.0.0.1:2");
    expect(routerA.acquireSourceLease("github", "router-a")).toBe(true);
    expect(routerB.acquireSourceLease("github", "router-b")).toBe(false);
    expect(routerA.renewSourceLease("github", "router-a")).toBe(true);
    expect(routerB.renewSourceLease("github", "router-b")).toBe(false);
    routerA.releaseSourceLease("github", "router-a");
    expect(routerB.acquireSourceLease("github", "router-b")).toBe(true);

    const { workItemId } = first.execute(
      {
        type: "workitem.create",
        requestId: "req_router",
        repo: "owner/repo",
        title: "竞争",
        request: "只允许一个赢家",
      },
      "local-device",
    );
    first.db
      .prepare(
        "INSERT INTO worker_nodes(id, name, token_hash, protocol_version, capabilities_json, status, created_at, updated_at) VALUES ('node-a', 'A', 'hash-a', 1, '{}', 'ACTIVE', 0, 0), ('node-b', 'B', 'hash-b', 1, '{}', 'ACTIVE', 0, 0)",
      )
      .run();
    const lease = routerA.claim(workItemId!, "node-a")!;
    expect(lease).not.toBeNull();
    expect(routerB.claim(workItemId!, "node-b")).toBeNull();
    expect(routerA.finish(lease.id, "node-a", lease.fence + 1)).toBe(false);
    expect(routerA.finish(lease.id, "node-a", lease.fence)).toBe(true);
    const secondLease = routerB.claim(workItemId!, "node-b")!;
    routerB.revokeNode("node-b");
    expect(routerB.renew(secondLease.id, "node-b", secondLease.fence)).toBe(false);
    expect(routerB.claim(workItemId!, "node-b")).toBeNull();
    expect(routerA.claim(workItemId!, "node-a")).not.toBeNull();
  }, 60_000);

  it("SQLite→PostgreSQL 保留审批、Run、Outbox 与 Artifact 引用", async () => {
    const { home, options } = await fixture();
    const sqlite = new SqliteSuperAgentStore(join(home, "source.sqlite"));
    const { workItemId } = sqlite.execute(
      { type: "workitem.create", requestId: "req_migrate", repo: "owner/repo", title: "迁移", request: "迁移引用" },
      "local-device",
    );
    sqlite.execute(
      {
        type: "plan.submit",
        workItemId: workItemId!,
        content: "计划",
        baseSha: "abc",
        verification: ["pnpm test"],
        changeScope: ["src/**"],
      },
      "local-device",
    );
    const plan = sqlite.snapshot().plans[0]!;
    sqlite.execute(
      { type: "plan.approve", workItemId: workItemId!, planId: plan.id, planHash: plan.planHash },
      "local-device",
    );
    sqlite.db
      .prepare(
        "INSERT INTO outbox(id, conversation_id, kind, payload_json, status, next_run_at, created_at, updated_at) VALUES ('ob_migrate', 'chat', 'test', '{}', 'PENDING', 0, 0, 0)",
      )
      .run();
    const artifact = sqlite.artifacts.put({ workItemId, kind: "plan", content: "计划", mimeType: "text/markdown" });
    sqlite.db.prepare("UPDATE plan_revisions SET artifact_id = ? WHERE id = ?").run(artifact.id, plan.id);
    const backupFile = join(home, "backup.json");
    exportStoreBackup(sqlite, backupFile);
    sqlite.close();
    const pg = new PostgresSuperAgentStore(options);
    cleanups.push(() => pg.close());
    importStoreBackup(pg, readStoreBackup(backupFile));
    const snapshot = pg.snapshot();
    expect(snapshot.workItems).toHaveLength(1);
    expect(snapshot.plans).toHaveLength(1);
    expect(snapshot.plans[0]?.artifactId).toBe(artifact.id);
    expect(Number(pg.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n)).toBe(1);
    expect(Number(pg.db.prepare("SELECT COUNT(*) AS n FROM approvals").get()!.n)).toBe(1);
    expect(pg.db.prepare("SELECT id FROM outbox WHERE id = 'ob_migrate'").get()!.id).toBe("ob_migrate");
    expect(pg.artifacts.get(artifact.id)?.sha256).toBe(artifact.sha256);
  }, 60_000);
});
