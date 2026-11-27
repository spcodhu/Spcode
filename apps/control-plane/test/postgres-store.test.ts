import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { afterEach, describe, expect, it } from "vitest";
import { PostgresSuperAgentStore } from "../src/store-postgres.js";
import { WorkerStore } from "../src/worker-store.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("真实 PostgreSQL Store", () => {
  it("Trigger、审批、Attempt fence 与 Outbox 使用同一事务", async () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-pg-test-"));
    const port = 55432;
    const pg = new EmbeddedPostgres({
      databaseDir: join(home, "pg-data"),
      port,
      user: "postgres",
      password: "test-password",
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
    const store = new PostgresSuperAgentStore({
      connectionString: `postgresql://postgres:test-password@127.0.0.1:${port}/postgres`,
      baseDir: join(home, "artifacts"),
      workerFile: new URL("../dist/postgres-sync-worker.mjs", import.meta.url),
    });
    cleanups.push(() => store.close());
    const { workItemId } = store.execute(
      { type: "workitem.create", requestId: "req_pg", repo: "owner/repo", title: "PG", request: "验证事务" },
      "local-device",
    );
    store.execute(
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
    const plan = store.snapshot().plans[0]!;
    store.execute(
      { type: "plan.approve", workItemId: workItemId!, planId: plan.id, planHash: plan.planHash },
      "local-device",
    );
    store.execute(
      { type: "plan.approve", workItemId: workItemId!, planId: plan.id, planHash: plan.planHash },
      "local-device",
    );
    expect(store.snapshot().workItems[0]?.status).toBe("QUEUED");
    expect(Number(store.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n)).toBe(1);
    const workers = new WorkerStore(store.db, () => {});
    const attempt = workers.startAttempt(workItemId!, "execute");
    expect(attempt.fence).toBe(1);
    expect(() => workers.startAttempt(workItemId!, "execute")).toThrow(/活跃 Attempt/);
    workers.attachWorker(attempt.id, attempt.fence, 4242, {
      workItemId: workItemId!,
      repo: "owner/repo",
      sourcePath: "/source",
      mirrorPath: "/mirror",
      worktreePath: "/worktree/pg",
      branch: "superagent/pg",
      baseSha: "abc",
    });
    expect(workers.heartbeat(attempt.id, attempt.fence)).toBe(true);
    store.db
      .prepare(
        "INSERT INTO outbox(id, conversation_id, kind, payload_json, status, next_run_at, created_at, updated_at) VALUES ('ob_pg', 'chat', 'test', '{}', 'PENDING', 0, 0, 0)",
      )
      .run();
    expect(store.db.prepare("SELECT status FROM outbox WHERE id = 'ob_pg'").get()!.status).toBe("PENDING");
    expect(workers.getAttempt(attempt.id).role).toBe("execute");
  }, 60_000);
});
