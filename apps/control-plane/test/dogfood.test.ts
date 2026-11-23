import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../src/server.js";
import { NodeWorkerRunner } from "../src/worker-runner.js";

const root = dirname(fileURLToPath(import.meta.url));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("当前 monorepo dogfood", () => {
  it("真实当前仓库闭环不改变用户 HEAD、分支或状态", async () => {
    const userCwd = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const userHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: userCwd, encoding: "utf8" }).trim();
    const userBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: userCwd,
      encoding: "utf8",
    }).trim();
    const userStatus = execFileSync("git", ["status", "--porcelain"], { cwd: userCwd, encoding: "utf8" }).trim();
    const home = mkdtempSync(join(tmpdir(), "spcode-dogfood-"));
    const workbenchDir = join(home, "workbench");
    mkdirSync(workbenchDir, { recursive: true });
    writeFileSync(join(workbenchDir, "index.html"), "<title>Spcode</title>");
    const plane = new ControlPlane({
      baseDir: home,
      spcodeHome: home,
      workbenchDir,
      port: 0,
      superAgentEnabled: true,
      resolveRepoPath: () => userCwd,
      workerRunner: new NodeWorkerRunner(home, resolve(root, "../src/fake-worker.ts"), { SPCODE_HOME: home }),
      workerPollMs: 20,
      watchdogEnabled: false,
    });
    cleanups.push(async () => {
      await plane.close().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    });
    const { port, deviceToken } = await plane.start();
    const origin = `http://127.0.0.1:${port}`;
    const bootstrap = await fetch(`${origin}/api/v1/auth/bootstrap`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        Origin: origin,
        "X-Spcode-Control-Client": "1",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    await fetch(`${origin}/api/v1/superagent/commands`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "X-Spcode-Control-Client": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "workitem.create",
        requestId: "req_dogfood",
        repo: "spcodhu/Spcode",
        title: "当前仓库 dogfood",
        request: "验证隔离执行",
      }),
    });
    const deadline = Date.now() + 12_000;
    let state: any;
    for (;;) {
      const response = await fetch(`${origin}/api/v1/superagent/snapshot`, { headers: { Cookie: cookie } });
      state = await response.json();
      if (state.workItems[0]?.status === "AWAITING_PLAN_APPROVAL") break;
      if (Date.now() > deadline) throw new Error("dogfood 计划超时");
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    }
    const item = state.workItems[0];
    const plan = state.plans[0];
    await fetch(`${origin}/api/v1/superagent/commands`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "X-Spcode-Control-Client": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "plan.approve", workItemId: item.id, planId: plan.id, planHash: plan.planHash }),
    });
    for (;;) {
      const response = await fetch(`${origin}/api/v1/superagent/snapshot`, { headers: { Cookie: cookie } });
      state = await response.json();
      if (state.workItems[0]?.status === "COMPLETED") break;
      if (Date.now() > deadline) throw new Error("dogfood 执行超时");
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    }
    const completed = state.workItems[0];
    expect(completed.baseSha).toBe(userHead);
    expect(completed.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(
      execFileSync("git", ["rev-list", "--count", `${completed.baseSha}..HEAD`], {
        cwd: completed.worktreePath,
        encoding: "utf8",
      }).trim(),
    ).toBe("1");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: userCwd, encoding: "utf8" }).trim()).toBe(userHead);
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: userCwd, encoding: "utf8" }).trim()).toBe(
      userBranch,
    );
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: userCwd, encoding: "utf8" }).trim()).toBe(userStatus);
  }, 30_000);
});
