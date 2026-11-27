import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../src/server.js";
import { NodeWorkerRunner } from "../src/worker-runner.js";

const root = dirname(fileURLToPath(import.meta.url));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("两个真实 Router 共享 PostgreSQL", () => {
  it("同一 WorkItem 计划与执行各只有一个 Attempt，状态跨 Router 一致", async () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-multi-router-"));
    const repo = join(home, "repo");
    const workbenchDir = join(home, "workbench");
    mkdirSync(workbenchDir, { recursive: true });
    writeFileSync(join(workbenchDir, "index.html"), "<title>Spcode</title>");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
    const pg = new EmbeddedPostgres({
      databaseDir: join(home, "pg"),
      port: 55434,
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
    const postgres = {
      connectionString: "postgresql://postgres:test@127.0.0.1:55434/postgres",
      workerFile: new URL("../dist/postgres-sync-worker.mjs", import.meta.url),
    };
    const make = (name: string) => {
      const baseDir = join(home, name);
      return new ControlPlane({
        baseDir,
        spcodeHome: baseDir,
        workbenchDir,
        port: 0,
        superAgentEnabled: true,
        resolveRepoPath: () => repo,
        workerRunner: new NodeWorkerRunner(baseDir, resolve(root, "../src/fake-worker.ts"), { SPCODE_HOME: baseDir }),
        workerPollMs: 30,
        postgres,
        digestSchedulerEnabled: false,
        watchdogEnabled: false,
      });
    };
    const a = make("router-a");
    const b = make("router-b");
    cleanups.push(async () => {
      await a.close().catch(() => {});
      await b.close().catch(() => {});
    });
    const startedA = await a.start();
    const startedB = await b.start();
    const origin = `http://127.0.0.1:${startedA.port}`;
    const bootstrap = await fetch(`${origin}/api/v1/auth/bootstrap`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${startedA.deviceToken}`,
        Origin: origin,
        "X-Spcode-Control-Client": "1",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    const command = (body: unknown) =>
      fetch(`${origin}/api/v1/superagent/commands`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "X-Spcode-Control-Client": "1", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const snapshot = async () =>
      await (await fetch(`${origin}/api/v1/superagent/snapshot`, { headers: { Cookie: cookie } })).json();
    await command({
      type: "workitem.create",
      requestId: "req_multi_router",
      repo: "owner/repo",
      title: "多 Router",
      request: "验证 CAS",
    });
    const deadline = Date.now() + 12000;
    let state: any;
    for (;;) {
      state = await snapshot();
      if (state.workItems[0]?.status === "AWAITING_PLAN_APPROVAL") break;
      if (Date.now() > deadline) throw new Error(`多 Router 计划超时 ${JSON.stringify(state.workItems)}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    }
    expect(state.attempts.filter((attempt: { role: string }) => attempt.role === "plan")).toHaveLength(1);
    const item = state.workItems[0];
    const plan = state.plans[0];
    await command({ type: "plan.approve", workItemId: item.id, planId: plan.id, planHash: plan.planHash });
    for (;;) {
      state = await snapshot();
      if (state.workItems[0]?.status === "COMPLETED") break;
      if (Date.now() > deadline) throw new Error(`多 Router 执行超时 ${JSON.stringify(state.workItems)}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    }
    expect(state.attempts.filter((attempt: { role: string }) => attempt.role === "execute")).toHaveLength(1);
    expect(Number(state.workItems[0].commitSha ? 1 : 0)).toBe(1);
    const bootstrapB = await fetch(`http://127.0.0.1:${startedB.port}/api/v1/auth/bootstrap`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${startedB.deviceToken}`,
        Origin: `http://127.0.0.1:${startedB.port}`,
        "X-Spcode-Control-Client": "1",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const cookieB = bootstrapB.headers.get("set-cookie")!.split(";")[0]!;
    const stateB = await (
      await fetch(`http://127.0.0.1:${startedB.port}/api/v1/superagent/snapshot`, { headers: { Cookie: cookieB } })
    ).json();
    expect(stateB.workItems[0].status).toBe("COMPLETED");
    expect(stateB.workItems[0].commitSha).toBe(state.workItems[0].commitSha);
    await a.close();
    await b.close();
  }, 60_000);
});
