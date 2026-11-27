import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane as Server } from "../../control-plane/src/server.js";
import { SqliteSuperAgentStore } from "../../control-plane/src/store-sqlite.js";
import { WorkerNodeApp } from "../src/node.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("三个真实 Worker Node", () => {
  it("并行计划、批准、执行与 Artifact 上传，三个节点各自持有 lease", async () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-worker-nodes-"));
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
    const plane = new Server({
      baseDir: home,
      spcodeHome: home,
      workbenchDir,
      port: 0,
      superAgentEnabled: true,
      localWorkerEnabled: false,
      watchdogEnabled: false,
      digestSchedulerEnabled: false,
    });
    cleanups.push(async () => {
      await plane.close().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    });
    const started = await plane.start();
    const origin = `http://127.0.0.1:${started.port}`;
    const bootstrap = await fetch(`${origin}/api/v1/auth/bootstrap`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${started.deviceToken}`,
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
    const runtime = JSON.parse(readFileSync(join(home, "runtime.json"), "utf8")) as { serviceToken: string };
    process.env.SPCODE_SUPERAGENT_FAKE_WORKER = "1";
    const nodes = ["node-a", "node-b", "node-c"].map(
      (name) =>
        new WorkerNodeApp({
          controlUrl: origin,
          name,
          dataDir: join(home, name),
          pairToken: runtime.serviceToken,
          capacity: 1,
          pollMs: 20,
          repoSource: () => repo,
        }),
    );
    cleanups.push(async () => {
      for (const node of nodes) await node.stop();
      delete process.env.SPCODE_SUPERAGENT_FAKE_WORKER;
    });
    for (const node of nodes) await node.start();
    for (const title of ["A", "B", "C"]) {
      await command({
        type: "workitem.create",
        requestId: `req_${title}`,
        repo: "owner/repo",
        title,
        request: `任务 ${title}`,
      });
    }
    const deadline = Date.now() + 15000;
    let state: any;
    for (;;) {
      state = await snapshot();
      if (
        state.workItems.length === 3 &&
        state.workItems.every((item: { status: string }) => item.status === "AWAITING_PLAN_APPROVAL")
      )
        break;
      if (Date.now() > deadline) throw new Error(`三节点计划超时 ${JSON.stringify(state.workItems)}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(state.attempts.filter((attempt: { role: string }) => attempt.role === "plan")).toHaveLength(3);
    for (const item of state.workItems) {
      const plan = state.plans.find((candidate: { workItemId: string }) => candidate.workItemId === item.id)!;
      await command({ type: "plan.approve", workItemId: item.id, planId: plan.id, planHash: plan.planHash });
    }
    for (;;) {
      state = await snapshot();
      if (state.workItems.every((item: { status: string }) => item.status === "COMPLETED")) break;
      if (Date.now() > deadline) throw new Error(`三节点执行超时 ${JSON.stringify(state.workItems)}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(state.attempts.filter((attempt: { role: string }) => attempt.role === "execute")).toHaveLength(3);
    expect(new Set(state.workItems.map((item: { commitSha: string }) => item.commitSha)).size).toBe(3);
    expect(state.artifacts.length).toBeGreaterThan(0);
    const db = new SqliteSuperAgentStore(join(home, "control.sqlite"));
    expect(db.db.prepare("SELECT COUNT(DISTINCT node_id) AS n FROM worker_leases").get()!.n).toBe(3);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM worker_nodes WHERE status = 'ACTIVE'").get()!.n).toBe(3);
    db.close();
  }, 30_000);
});
