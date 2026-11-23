import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SuperAgentEngine } from "@spcode/superagent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitWorkspaceManager } from "../src/git-workspace.js";
import { SqliteSuperAgentStore } from "../src/store-sqlite.js";
import { InjectedWorkerFault, WorkerManager, type WorkerManagerOptions } from "../src/worker-manager.js";
import type { WorkerHandle, WorkerRunInput, WorkerRunner } from "../src/worker-runner.js";
import { WorkerStore } from "../src/worker-store.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

class TestRunner implements WorkerRunner {
  active = 0;
  maxActive = 0;
  constructor(private readonly verificationCommand = 'node -e "process.exit(0)"') {}
  async start(input: WorkerRunInput): Promise<WorkerHandle> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    const done = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (input.attempt.role === "plan") {
        return {
          planContent: `# 计划\n\n${input.item.request}\n\n## 验证命令\n${this.verificationCommand}\n\n## 拟改范围\n- superagent-result.md\n`,
          logPath: "test.log",
        };
      }
      writeFileSync(join(input.workspace.worktreePath, `${input.item.title}.md`), `${input.item.id}\n`);
      return {
        report: {
          status: "ready" as const,
          summary: "真实写入测试 worktree",
          tests: [{ command: this.verificationCommand, status: "passed" as const }],
          commitMessage: `功能: ${input.item.title}`,
        },
        logPath: "test.log",
      };
    })().finally(() => {
      this.active--;
    });
    return {
      pid: process.pid,
      done,
      stop: async () => {},
    };
  }
}

async function fixture(options: Partial<WorkerManagerOptions> = {}, verificationCommand?: string) {
  const home = mkdtempSync(join(tmpdir(), "spcode-worker-manager-"));
  const repo = join(home, "checkout");
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
  const store = new SqliteSuperAgentStore(join(home, "superagent", "control.sqlite"));
  const publish = vi.fn();
  const engine = new SuperAgentEngine(store, { publish });
  const workers = new WorkerStore(store.db, publish);
  const git = new GitWorkspaceManager(join(home, "superagent"), () => repo);
  const runner = new TestRunner(verificationCommand);
  const errors: Error[] = [];
  const manager = new WorkerManager({
    baseDir: home,
    store,
    workers,
    git,
    runner,
    engine,
    pollMs: 20,
    ...options,
    onError: (error, workItemId) => {
      errors.push(error);
      options.onError?.(error, workItemId);
    },
  });
  cleanups.push(async () => {
    await manager.stop().catch(() => {});
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, repo, store, engine, workers, git, runner, manager, errors };
}

function create(engine: SuperAgentEngine, requestId: string, title = requestId): string {
  return engine.execute(
    { type: "workitem.create", requestId, repo: "owner/repo", title, request: `完成 ${title}` },
    "local-device",
  ).workItemId!;
}

function approve(store: SqliteSuperAgentStore, engine: SuperAgentEngine, workItemId: string): void {
  const plan = store.snapshot().plans.find((candidate) => candidate.workItemId === workItemId)!;
  engine.execute({ type: "plan.approve", workItemId, planId: plan.id, planHash: plan.planHash }, "local-device");
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 8000,
  context: () => unknown = () => undefined,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待 Worker 状态超时：${JSON.stringify(context())}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("WorkerManager 单机可信闭环", () => {
  it("只读计划释放进程，批准后验证并生成一个本地 commit", async () => {
    const { repo, store, engine, workers, manager, runner, errors } = await fixture();
    const workItemId = create(engine, "req_full", "full");
    writeFileSync(join(repo, "user-dirty.txt"), "keep\n");
    const userHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const userStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim();
    await manager.start();
    await waitFor(
      () => workers.getItem(workItemId).status === "AWAITING_PLAN_APPROVAL",
      8000,
      () => ({ item: workers.getItem(workItemId), errors: errors.map((error) => error.message) }),
    );
    expect(workers.getItem(workItemId).activeAttemptId).toBeNull();
    expect(runner.active).toBe(0);
    expect(store.snapshot().plans[0]!.verification).toEqual(['node -e "process.exit(0)"']);
    approve(store, engine, workItemId);
    await waitFor(() => workers.getItem(workItemId).status === "COMPLETED");
    const item = workers.getItem(workItemId);
    expect(item.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(item.report?.tests[0]?.status).toBe("passed");
    expect(
      execFileSync("git", ["rev-list", "--count", `${item.baseSha}..HEAD`], {
        cwd: item.worktreePath!,
        encoding: "utf8",
      }).trim(),
    ).toBe("1");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()).toBe(userHead);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim()).toBe(userStatus);
  });

  it("两个 WorkItem 真正并行且不串 worktree / commit", async () => {
    const { store, engine, workers, manager, runner } = await fixture();
    const first = create(engine, "req_parallel_1", "parallel-1");
    const second = create(engine, "req_parallel_2", "parallel-2");
    await manager.start();
    await waitFor(() => [first, second].every((id) => workers.getItem(id).status === "AWAITING_PLAN_APPROVAL"));
    approve(store, engine, first);
    approve(store, engine, second);
    await waitFor(() => [first, second].every((id) => workers.getItem(id).status === "COMPLETED"));
    const a = workers.getItem(first);
    const b = workers.getItem(second);
    expect(runner.maxActive).toBe(2);
    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(a.commitSha).not.toBe(b.commitSha);
  });

  it("commit 后回执前崩溃，恢复只登记实际 commit，不重复提交", async () => {
    const fixtureValue = await fixture({
      afterCommit: () => {
        throw new InjectedWorkerFault("crash after commit");
      },
    });
    const { store, engine, workers, manager } = fixtureValue;
    const workItemId = create(engine, "req_crash", "crash");
    await manager.start();
    await waitFor(() => workers.getItem(workItemId).status === "AWAITING_PLAN_APPROVAL");
    approve(store, engine, workItemId);
    await waitFor(() => {
      const item = workers.getItem(workItemId);
      if (item.status !== "COMMITTING" || !item.worktreePath) return false;
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: item.worktreePath, encoding: "utf8" }).trim();
      return head !== item.baseSha;
    });
    const before = workers.getItem(workItemId);
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: before.worktreePath!, encoding: "utf8" }).trim();
    const recovery = new WorkerManager({
      ...(manager as unknown as { options: WorkerManagerOptions }).options,
      afterCommit: undefined,
    });
    await recovery.recover();
    const after = workers.getItem(workItemId);
    expect(after.status).toBe("COMPLETED");
    expect(after.commitSha).toBe(sha);
    expect(
      execFileSync("git", ["rev-list", "--count", `${after.baseSha}..HEAD`], {
        cwd: after.worktreePath!,
        encoding: "utf8",
      }).trim(),
    ).toBe("1");
  });

  it("控制面复跑验证失败时不产生 commit", async () => {
    const { store, engine, workers, manager } = await fixture({}, 'node -e "process.exit(7)"');
    const workItemId = create(engine, "req_failed", "failed");
    await manager.start();
    await waitFor(() => workers.getItem(workItemId).status === "AWAITING_PLAN_APPROVAL");
    approve(store, engine, workItemId);
    await waitFor(() => workers.getItem(workItemId).status === "FAILED");
    const item = workers.getItem(workItemId);
    expect(item.commitSha).toBeNull();
    expect(item.report?.tests[0]).toMatchObject({ status: "failed", exitCode: 7 });
  });
});
