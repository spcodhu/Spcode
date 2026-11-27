import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ControlPlane } from "../../control-plane/src/server.js";
import { SqliteSuperAgentStore } from "../../control-plane/src/store-sqlite.js";
import { WorkerNodeApp } from "../src/node.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("Worker Node 断线重租与吊销", () => {
  it("失联节点由另一节点用 RecoveryBundle 接管，旧 fence 与 revoked 节点失效", async () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-worker-recovery-"));
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
    const plane = new ControlPlane({
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
    process.env.SPCODE_FAKE_WORKER_DELAY = "5000";
    const nodeA = new WorkerNodeApp({
      controlUrl: origin,
      name: "node-a",
      dataDir: join(home, "node-a"),
      pairToken: runtime.serviceToken,
      repoSource: () => repo,
      pollMs: 20,
    });
    const nodeB = new WorkerNodeApp({
      controlUrl: origin,
      name: "node-b",
      dataDir: join(home, "node-b"),
      pairToken: runtime.serviceToken,
      repoSource: () => repo,
      pollMs: 20,
    });
    cleanups.push(async () => {
      await nodeA.stop();
      await nodeB.stop();
      delete process.env.SPCODE_SUPERAGENT_FAKE_WORKER;
      delete process.env.SPCODE_FAKE_WORKER_DELAY;
    });
    await nodeA.start();
    await command({
      type: "workitem.create",
      requestId: "req_recovery",
      repo: "owner/repo",
      title: "断线恢复",
      request: "跨节点接管",
    });
    const deadline = Date.now() + 15000;
    let state: any;
    for (;;) {
      state = await snapshot();
      if (state.workItems[0]?.status === "AWAITING_PLAN_APPROVAL") break;
      if (Date.now() > deadline) throw new Error("计划超时");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const plan = state.plans[0];
    await command({
      type: "plan.approve",
      workItemId: state.workItems[0].id,
      planId: plan.id,
      planHash: plan.planHash,
    });
    for (;;) {
      state = await snapshot();
      if (
        state.attempts.some(
          (attempt: { role: string; status: string }) => attempt.role === "execute" && attempt.status === "RUNNING",
        )
      )
        break;
      if (Date.now() > deadline) throw new Error("执行未开始");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const oldAttempt = state.attempts.find((attempt: { role: string }) => attempt.role === "execute")!;
    nodeA.disconnect();
    const db = new SqliteSuperAgentStore(join(home, "control.sqlite"));
    db.db.prepare("UPDATE worker_leases SET expires_at = 0 WHERE id = ?").run(oldAttempt.id);
    db.close();
    plane.recoverWorkerNodes();
    await nodeB.start();
    for (;;) {
      state = await snapshot();
      if (state.workItems[0]?.status === "COMPLETED") break;
      if (Date.now() > deadline) throw new Error(`跨节点恢复超时 ${JSON.stringify(state.workItems)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const executions = state.attempts
      .filter((attempt: { role: string }) => attempt.role === "execute")
      .sort((a: { fence: number }, b: { fence: number }) => a.fence - b.fence);
    expect(executions).toHaveLength(2);
    expect(executions[1].fence).toBeGreaterThan(executions[0].fence);
    expect(state.workItems[0].commitSha).toMatch(/^[0-9a-f]{40}$/);
    const recoveryDb = new SqliteSuperAgentStore(join(home, "control.sqlite"));
    expect(recoveryDb.db.prepare("SELECT COUNT(*) AS n FROM recovery_bundles").get()!.n).toBe(1);
    const bundle = recoveryDb.db.prepare("SELECT bundle_hash, snapshot_version FROM recovery_bundles").get()!;
    expect(bundle.bundle_hash).toHaveLength(64);
    expect(bundle.snapshot_version).toBeGreaterThan(0);
    expect(
      recoveryDb.db.prepare("SELECT node_id FROM worker_leases WHERE id = ?").get(executions[1].id)!.node_id,
    ).not.toBe(recoveryDb.db.prepare("SELECT node_id FROM worker_leases WHERE id = ?").get(executions[0].id)!.node_id);
    recoveryDb.close();

    const credentials = JSON.parse(readFileSync(join(home, "node-a", "node.json"), "utf8")) as {
      nodeId: string;
      nodeToken: string;
    };
    const stale = new WebSocket(`ws://127.0.0.1:${started.port}/api/v1/worker-node`, {
      headers: {
        Authorization: `Bearer ${credentials.nodeId}:${credentials.nodeToken}`,
        "X-Spcode-Worker-Protocol": "1",
      },
    });
    await new Promise<void>((resolve) =>
      stale.on("open", () => {
        stale.send(
          JSON.stringify({
            type: "worker.event",
            attemptId: oldAttempt.id,
            fence: oldAttempt.fence,
            seq: 999,
            eventType: "stale",
            payload: {},
          }),
        );
        setTimeout(resolve, 50);
      }),
    );
    stale.close();
    const staleDb = new SqliteSuperAgentStore(join(home, "control.sqlite"));
    expect(
      staleDb.db.prepare("SELECT last_event_seq FROM attempts WHERE id = ?").get(oldAttempt.id)!.last_event_seq,
    ).toBe(oldAttempt.lastEventSeq);
    staleDb.close();

    await fetch(`${origin}/api/v1/worker-nodes/revoke`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtime.serviceToken}`,
        "X-Spcode-Control-Client": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ nodeId: credentials.nodeId }),
    });
    const nodes = await (await fetch(`${origin}/api/v1/worker-nodes`, { headers: { Cookie: cookie } })).json();
    expect(nodes.nodes.find((node: { id: string }) => node.id === credentials.nodeId).status).toBe("REVOKED");
  }, 30_000);
});
