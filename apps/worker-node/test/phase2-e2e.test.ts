import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import EmbeddedPostgres from "embedded-postgres";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../../control-plane/src/server.js";
import { PostgresSuperAgentStore } from "../../control-plane/src/store-postgres.js";
import { WorkerNodeApp } from "../src/node.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("阶段二 2 Router + 3 Worker Node", () => {
  it("多个独立 Thread 并行且不双执行，节点增加有效并发", async () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-phase2-topology-"));
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
      port: 55435,
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
      connectionString: "postgresql://postgres:test@127.0.0.1:55435/postgres",
      workerFile: new URL("../../control-plane/dist/postgres-sync-worker.mjs", import.meta.url),
    };
    const makeRouter = (name: string) => {
      const baseDir = join(home, name);
      return new ControlPlane({
        baseDir,
        spcodeHome: baseDir,
        workbenchDir,
        port: 0,
        superAgentEnabled: true,
        localWorkerEnabled: false,
        resolveRepoPath: () => repo,
        workerPollMs: 20,
        postgres,
        digestSchedulerEnabled: false,
        watchdogEnabled: false,
      });
    };
    const a = makeRouter("router-a");
    const b = makeRouter("router-b");
    cleanups.push(async () => {
      await a.close().catch(() => {});
      await b.close().catch(() => {});
    });
    const startedA = await a.start();
    const startedB = await b.start();
    const originA = `http://127.0.0.1:${startedA.port}`;
    const originB = `http://127.0.0.1:${startedB.port}`;
    const bootstrap = await fetch(`${originA}/api/v1/auth/bootstrap`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${startedA.deviceToken}`,
        Origin: originA,
        "X-Spcode-Control-Client": "1",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    const command = (body: unknown) =>
      fetch(`${originA}/api/v1/superagent/commands`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: originA,
          "X-Spcode-Control-Client": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const snapshot = async () =>
      await (await fetch(`${originA}/api/v1/superagent/snapshot`, { headers: { Cookie: cookie } })).json();
    const runtimeA = JSON.parse(readFileSync(join(home, "router-a", "runtime.json"), "utf8")) as {
      serviceToken: string;
    };
    const runtimeB = JSON.parse(readFileSync(join(home, "router-b", "runtime.json"), "utf8")) as {
      serviceToken: string;
    };
    process.env.SPCODE_SUPERAGENT_FAKE_WORKER = "1";
    process.env.SPCODE_FAKE_WORKER_DELAY = "250";
    const nodes = [
      new WorkerNodeApp({
        controlUrl: originA,
        name: "node-a",
        dataDir: join(home, "node-a"),
        pairToken: runtimeA.serviceToken,
        repoSource: () => repo,
        pollMs: 20,
      }),
      new WorkerNodeApp({
        controlUrl: originA,
        name: "node-b",
        dataDir: join(home, "node-b"),
        pairToken: runtimeA.serviceToken,
        repoSource: () => repo,
        pollMs: 20,
      }),
      new WorkerNodeApp({
        controlUrl: originB,
        name: "node-c",
        dataDir: join(home, "node-c"),
        pairToken: runtimeB.serviceToken,
        repoSource: () => repo,
        pollMs: 20,
      }),
    ];
    cleanups.push(async () => {
      for (const node of nodes) await node.stop();
      delete process.env.SPCODE_SUPERAGENT_FAKE_WORKER;
      delete process.env.SPCODE_FAKE_WORKER_DELAY;
    });
    for (const node of nodes) await node.start();
    const startedAt = performance.now();
    for (const title of ["A", "B", "C"])
      await command({
        type: "workitem.create",
        requestId: `req_topology_${title}`,
        repo: "owner/repo",
        title,
        request: `拓扑 ${title}`,
      });
    const deadline = Date.now() + 20000;
    let state: any;
    for (;;) {
      state = await snapshot();
      if (
        state.workItems.length === 3 &&
        state.workItems.every((item: { status: string }) => item.status === "AWAITING_PLAN_APPROVAL")
      )
        break;
      if (Date.now() > deadline) throw new Error(`拓扑计划超时 ${JSON.stringify(state.workItems)}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    for (const item of state.workItems) {
      const plan = state.plans.find((candidate: { workItemId: string }) => candidate.workItemId === item.id)!;
      await command({ type: "plan.approve", workItemId: item.id, planId: plan.id, planHash: plan.planHash });
    }
    for (;;) {
      state = await snapshot();
      if (state.workItems.every((item: { status: string }) => item.status === "COMPLETED")) break;
      if (Date.now() > deadline) throw new Error(`拓扑执行超时 ${JSON.stringify(state.workItems)}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const wallMs = performance.now() - startedAt;
    expect(state.attempts.filter((attempt: { role: string }) => attempt.role === "plan")).toHaveLength(3);
    expect(state.attempts.filter((attempt: { role: string }) => attempt.role === "execute")).toHaveLength(3);
    expect(wallMs).toBeLessThan(2500);
    const db = new PostgresSuperAgentStore({ ...postgres, baseDir: join(home, "check") });
    expect(db.db.prepare("SELECT COUNT(DISTINCT node_id) AS n FROM worker_leases").get()!.n).toBe(3);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM routers WHERE status = 'ACTIVE'").get()!.n).toBe(2);
    db.close();
    const sortedDurations = state.attempts
      .map((attempt: { updatedAt: number; createdAt: number }) => attempt.updatedAt - attempt.createdAt)
      .sort((a: number, b: number) => a - b);
    const percentile = (p: number) =>
      sortedDurations[Math.min(sortedDurations.length - 1, Math.floor(sortedDurations.length * p))] ?? 0;
    console.log(`FAKE_WORKER_NODE_LOAD p50=${percentile(0.5)}ms p95=${percentile(0.95)}ms wallMs=${wallMs.toFixed(1)}`);
  }, 45_000);
});
