import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttemptSnapshot, PlanRevision } from "@spcode/shared/superagent";
import { afterEach, describe, expect, it } from "vitest";
import { NodeWorkerRunner, type WorkerRunInput } from "../src/worker-runner.js";
import type { ManagedWorkItem } from "../src/worker-store.js";

const root = dirname(fileURLToPath(import.meta.url));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function input(home: string, role: "plan" | "execute"): WorkerRunInput {
  const worktreePath = join(home, `worktree-${role}`);
  mkdirSync(worktreePath, { recursive: true });
  const item = {
    id: `wi_${role}`,
    triggerId: "tr_test",
    repo: "owner/repo",
    title: "独立进程",
    request: "验证 Node IPC",
    status: role === "plan" ? "PLANNING" : "RUNNING",
    desiredState: "ACTIVE",
    currentPlanId: role === "plan" ? null : "pl_test",
    activeAttemptId: `at_${role}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    workerSessionFile: null,
    worktreePath,
    branch: `superagent/wi_${role}`,
    baseSha: "a".repeat(40),
    commitSha: null,
    diff: null,
    report: null,
    lastError: null,
  } as ManagedWorkItem;
  const attempt = {
    id: `at_${role}`,
    runId: role === "plan" ? null : "run_test",
    workItemId: item.id,
    fence: 1,
    role,
    status: "STARTING",
    workerPid: null,
    worktreePath,
    branch: item.branch,
    heartbeatAt: null,
    leaseExpiresAt: null,
    report: null,
    lastError: null,
    lastEventSeq: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as AttemptSnapshot;
  const plan =
    role === "execute"
      ? ({ id: "pl_test", workItemId: item.id, content: "计划", status: "APPROVED" } as PlanRevision)
      : null;
  return {
    item,
    attempt,
    plan,
    workspace: {
      workItemId: item.id,
      repo: item.repo,
      sourcePath: home,
      mirrorPath: join(home, "mirror"),
      worktreePath,
      branch: item.branch!,
      baseSha: item.baseSha!,
    },
  };
}

describe("NodeWorkerRunner 独立进程 IPC", () => {
  it("计划与执行都在独立 PID 完成，stop 释放物理进程", async () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-node-runner-"));
    const runner = new NodeWorkerRunner(home, resolve(root, "../src/fake-worker.ts"), { SPCODE_HOME: home });
    const planning = await runner.start(input(home, "plan"), () => {});
    expect(planning.pid).not.toBe(process.pid);
    const plan = await planning.done;
    expect(plan.planContent).toContain("## 验证命令");
    await planning.stop();
    expect(planning.pid).toBeGreaterThan(0);

    const execution = await runner.start(input(home, "execute"), () => {});
    const result = await execution.done;
    expect(result.report?.status).toBe("ready");
    expect(readFileSync(join(home, "worktree-execute", "superagent-result.md"), "utf8")).toContain("wi_execute");
    await execution.stop();
    expect(existsSync(join(home, "fake-sessions", "wi_execute.jsonl"))).toBe(true);
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  });

  it("强杀 Worker 会拒绝 done，不会永久等待", async () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-node-kill-"));
    const runner = new NodeWorkerRunner(home, resolve(root, "../src/fake-worker.ts"), {
      SPCODE_HOME: home,
      SPCODE_FAKE_WORKER_DELAY: "5000",
    });
    const handle = await runner.start(input(home, "execute"), () => {});
    process.kill(handle.pid, "SIGKILL");
    await expect(handle.done).rejects.toThrow(/异常退出/);
    await handle.stop();
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  });
});
