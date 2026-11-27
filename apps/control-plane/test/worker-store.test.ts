import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerWorkReport } from "@spcode/shared/superagent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteSuperAgentStore } from "../src/store-sqlite.js";
import { WorkerStore } from "../src/worker-store.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "spcode-worker-store-"));
  const base = new SqliteSuperAgentStore(join(home, "control.sqlite"));
  const publish = vi.fn();
  const workers = new WorkerStore(base.db, publish);
  cleanups.push(() => {
    try {
      base.close();
    } catch {
      // 用例已显式验证重启关闭时无需重复 close。
    }
    rmSync(home, { recursive: true, force: true });
  });
  const { workItemId } = base.execute(
    {
      type: "workitem.create",
      requestId: "req_worker",
      repo: "owner/repo",
      title: "Worker 状态",
      request: "计划并执行",
    },
    "local-device",
  );
  return { base, workers, publish, workItemId: workItemId! };
}

function attach(workers: WorkerStore, attemptId: string, fence: number, workItemId: string) {
  workers.attachWorker(attemptId, fence, 1234, {
    workItemId,
    repo: "owner/repo",
    sourcePath: "/source",
    mirrorPath: "/mirror",
    worktreePath: `/worktree/${workItemId}`,
    branch: `superagent/${workItemId}`,
    baseSha: "a8ad263",
  });
}

const report: WorkerWorkReport = {
  status: "ready",
  summary: "完成",
  tests: [{ command: "pnpm test", status: "passed", exitCode: 0 }],
  commitMessage: "功能: 完成",
};

describe("WorkerStore Lease / Fence / Attempt", () => {
  it("计划等待不持 lease，批准后执行 Attempt 递增 fence，事件幂等", () => {
    const { base, workers, workItemId } = fixture();
    const planning = workers.startAttempt(workItemId, "plan");
    expect(planning.fence).toBe(1);
    expect(() => workers.startAttempt(workItemId, "plan")).toThrow(/活跃 Attempt/);
    attach(workers, planning.id, planning.fence, workItemId);
    workers.saveSessionFile(planning.id, planning.fence, "/session.jsonl");
    expect(workers.appendEvent(planning.id, planning.fence, 1, "progress", { text: "a" })).toBe(true);
    expect(workers.appendEvent(planning.id, planning.fence, 1, "progress", { text: "a" })).toBe(false);
    expect(workers.heartbeat(planning.id, planning.fence)).toBe(true);
    workers.finishAttempt(planning.id, planning.fence, "COMPLETED");
    expect(workers.getItem(workItemId).activeAttemptId).toBeNull();

    base.execute(
      {
        type: "plan.submit",
        workItemId,
        content: "计划",
        baseSha: "a8ad263",
        verification: ["pnpm test"],
        changeScope: ["src/**"],
      },
      "local-device",
    );
    expect(base.db.prepare("SELECT COUNT(*) AS n FROM leases").get()!.n).toBe(0);
    const plan = base.snapshot().plans[0]!;
    base.execute({ type: "plan.approve", workItemId, planId: plan.id, planHash: plan.planHash }, "local-device");
    const execution = workers.startAttempt(workItemId, "execute");
    expect(execution.fence).toBe(2);
    expect(execution.runId).not.toBeNull();
    attach(workers, execution.id, execution.fence, workItemId);
    expect(workers.appendEvent(planning.id, planning.fence, 2, "stale", {})).toBe(false);
    expect(workers.heartbeat(planning.id, planning.fence)).toBe(false);
    expect(() => workers.recordReport(planning.id, planning.fence, report)).toThrow(/stale fence/);
  });

  it("只有当前 fence 能推进验证、提交和完成，Run 只完成一次", () => {
    const { base, workers, workItemId } = fixture();
    base.execute(
      {
        type: "plan.submit",
        workItemId,
        content: "计划",
        baseSha: "a8ad263",
        verification: ["pnpm test"],
        changeScope: ["src/**"],
      },
      "local-device",
    );
    const plan = base.snapshot().plans[0]!;
    base.execute({ type: "plan.approve", workItemId, planId: plan.id, planHash: plan.planHash }, "local-device");
    const attempt = workers.startAttempt(workItemId, "execute");
    attach(workers, attempt.id, attempt.fence, workItemId);
    workers.setStatus(attempt.id, attempt.fence, "VALIDATING");
    workers.setStatus(attempt.id, attempt.fence, "COMMITTING");
    workers.recordReport(attempt.id, attempt.fence, report);
    workers.completeCommit(
      attempt.id,
      attempt.fence,
      "c".repeat(40),
      { stat: "1 file", patch: "diff", files: ["a"], untracked: [] },
      report,
    );
    const item = workers.getItem(workItemId);
    expect(item.status).toBe("COMPLETED");
    expect(item.commitSha).toBe("c".repeat(40));
    expect(item.activeAttemptId).toBeNull();
    expect(base.db.prepare("SELECT status FROM runs").get()!.status).toBe("COMPLETED");
    expect(() => workers.completeCommit(attempt.id, attempt.fence, "c".repeat(40), item.diff!, report)).toThrow(
      /stale fence/,
    );
  });

  it("执行崩溃进入 RECOVERING，干净基线才允许新 Attempt，旧 Worker 永久失效", () => {
    const { base, workers, workItemId } = fixture();
    base.execute(
      {
        type: "plan.submit",
        workItemId,
        content: "计划",
        baseSha: "a8ad263",
        verification: ["pnpm test"],
        changeScope: ["src/**"],
      },
      "local-device",
    );
    const plan = base.snapshot().plans[0]!;
    base.execute({ type: "plan.approve", workItemId, planId: plan.id, planHash: plan.planHash }, "local-device");
    const old = workers.startAttempt(workItemId, "execute");
    attach(workers, old.id, old.fence, workItemId);
    workers.markExecutionRecovering(old.id);
    expect(workers.getItem(workItemId).status).toBe("RECOVERING");
    workers.finishReconciliation(old.id, { status: "clean-base", detail: "干净" });
    expect(workers.getItem(workItemId).status).toBe("QUEUED");
    const next = workers.startAttempt(workItemId, "execute");
    attach(workers, next.id, next.fence, workItemId);
    expect(next.fence).toBeGreaterThan(old.fence);
    expect(() => workers.setStatus(old.id, old.fence, "FAILED", "late")).toThrow(/stale fence/);
    expect(workers.heartbeat(old.id, old.fence)).toBe(false);
  });

  it("schema v6 与审批事实可跨重启恢复", () => {
    const { base, workItemId } = fixture();
    const file = base.file;
    expect(base.db.prepare("PRAGMA user_version").get()!.user_version).toBe(6);
    expect(base.snapshot().workItems[0]!.id).toBe(workItemId);
    base.close();
    const reopened = new SqliteSuperAgentStore(file);
    expect(reopened.snapshot().workItems[0]!.id).toBe(workItemId);
    expect(reopened.snapshot().attempts).toEqual([]);
    reopened.close();
  });
});
