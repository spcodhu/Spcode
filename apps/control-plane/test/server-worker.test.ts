import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../src/server.js";
import { SqliteSuperAgentStore } from "../src/store-sqlite.js";
import { NodeWorkerRunner } from "../src/worker-runner.js";

const root = dirname(fileURLToPath(import.meta.url));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("控制面 + 独立 Worker 跨重启闭环", () => {
  it("计划跨重启、双人批准幂等、执行 commit、旧卡幂等", async () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-server-worker-"));
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
    const makePlane = () =>
      new ControlPlane({
        baseDir: home,
        spcodeHome: home,
        workbenchDir,
        port: 0,
        superAgentEnabled: true,
        resolveRepoPath: () => repo,
        workerRunner: new NodeWorkerRunner(home, resolve(root, "../src/fake-worker.ts"), { SPCODE_HOME: home }),
        workerPollMs: 20,
      });
    let plane = makePlane();
    let started = await plane.start();
    let origin = `http://127.0.0.1:${started.port}`;
    cleanups.push(async () => {
      await plane.close().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    });
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
    const headers = () => ({
      Cookie: cookie,
      Origin: origin,
      "X-Spcode-Control-Client": "1",
      "Content-Type": "application/json",
    });
    const command = async (body: unknown) =>
      fetch(`${origin}/api/v1/superagent/commands`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    const snapshot = async () => {
      const response = await fetch(`${origin}/api/v1/superagent/snapshot`, { headers: { Cookie: cookie } });
      expect(response.status).toBe(200);
      return response.json();
    };
    const waitFor = async (status: string) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const value = await snapshot();
        if (value.workItems[0]?.status === status) return value;
        if (Date.now() > deadline) throw new Error(`等待 ${status} 超时：${JSON.stringify(value.workItems[0])}`);
        await new Promise((resolveWait) => setTimeout(resolveWait, 30));
      }
    };

    const created = await command({
      type: "workitem.create",
      requestId: "req_server_worker",
      repo: "owner/repo",
      title: "跨重启 Worker",
      request: "生成计划并提交",
    });
    expect(created.status).toBe(200);
    const awaiting = await waitFor("AWAITING_PLAN_APPROVAL");
    const workItemId = awaiting.workItems[0].id;
    const plan = awaiting.plans[0];
    expect(
      awaiting.attempts.some(
        (attempt: { role: string; status: string }) => attempt.role === "plan" && attempt.status === "COMPLETED",
      ),
    ).toBe(true);

    await plane.close();
    plane = makePlane();
    started = await plane.start();
    origin = `http://127.0.0.1:${started.port}`;
    const recovered = await snapshot();
    expect(recovered.workItems[0].status).toBe("AWAITING_PLAN_APPROVAL");
    expect(recovered.plans[0].planHash).toBe(plan.planHash);

    const approval = { type: "plan.approve", workItemId, planId: plan.id, planHash: plan.planHash };
    const [firstApproval, secondApproval] = await Promise.all([command(approval), command(approval)]);
    expect(firstApproval.status).toBe(200);
    expect(secondApproval.status).toBe(200);
    const completed = await waitFor("COMPLETED");
    expect(completed.workItems[0].commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(completed.workItems[0].report.tests[0].status).toBe("passed");
    expect(
      completed.attempts.some(
        (attempt: { role: string; workerPid: number }) =>
          attempt.role === "execute" && attempt.workerPid !== process.pid,
      ),
    ).toBe(true);
    expect((await command(approval)).status).toBe(200);

    const item = completed.workItems[0];
    expect(
      execFileSync("git", ["rev-list", "--count", `${item.baseSha}..HEAD`], {
        cwd: item.worktreePath,
        encoding: "utf8",
      }).trim(),
    ).toBe("1");
    await plane.close();
    const db = new SqliteSuperAgentStore(join(home, "control.sqlite"));
    expect(Number(db.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n)).toBe(1);
    expect(Number(db.db.prepare("SELECT COUNT(*) AS n FROM approvals").get()!.n)).toBe(1);
    db.close();
  });
});
