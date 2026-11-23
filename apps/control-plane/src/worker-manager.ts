import { existsSync, readFileSync } from "node:fs";
import type { ModelRef } from "@spcode/shared";
import type { PlanRevision, WorkerWorkReport } from "@spcode/shared/superagent";
import type { SuperAgentEngine } from "@spcode/superagent";
import type { ArtifactStore } from "./artifact-store.js";
import type { GitWorkspace, GitWorkspaceManager } from "./git-workspace.js";
import { GitWorkspaceError } from "./git-workspace.js";
import type { SqliteSuperAgentStore } from "./store-sqlite.js";
import { runVerification } from "./verification.js";
import type { WorkerHandle, WorkerRunner } from "./worker-runner.js";
import type { ManagedWorkItem, WorkerStore } from "./worker-store.js";

export class InjectedWorkerFault extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InjectedWorkerFault";
  }
}

export interface WorkerManagerOptions {
  baseDir: string;
  store: SqliteSuperAgentStore;
  workers: WorkerStore;
  git: GitWorkspaceManager;
  runner: WorkerRunner;
  engine: SuperAgentEngine;
  artifacts?: ArtifactStore;
  concurrency?: () => number;
  budgetUsd?: () => number;
  model?: ModelRef;
  pollMs?: number;
  /** 故障注入：真实 commit 已完成，但 completeCommit 回执前中止。 */
  afterCommit?: () => void;
  onFault?: (error: Error) => void;
  onError?: (error: Error, workItemId: string) => void;
}

function planSection(content: string, headings: string[]): string[] {
  const normalized = new Set(headings.map((heading) => heading.toLowerCase()));
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const heading = /^##\s+(.+?)\s*$/.exec(line)?.[1]?.trim().toLowerCase();
    return !!heading && normalized.has(heading);
  });
  if (start < 0) return [];
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) break;
    section.push(line);
  }
  return section
    .map((line) => line.trim())
    .filter((line) => line && !/^```/.test(line))
    .map((line) =>
      line
        .replace(/^(?:[-*+] |\d+\.\s+)/, "")
        .replace(/^`|`$/g, "")
        .trim(),
    )
    .filter(Boolean);
}

export class WorkerManager {
  private readonly running = new Map<string, { attemptId: string; handle: WorkerHandle }>();
  private readonly tasks = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private accepting = false;

  constructor(private readonly options: WorkerManagerOptions) {}

  async start(): Promise<void> {
    await this.recover();
    this.accepting = true;
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.pollMs ?? 250);
  }

  async stop(): Promise<void> {
    this.accepting = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const running of this.running.values()) await running.handle.stop().catch(() => {});
    await Promise.all([...this.tasks]);
    await this.recover();
  }

  async tick(): Promise<void> {
    if (!this.accepting || this.ticking || this.options.store.processingPaused()) return;
    this.ticking = true;
    try {
      const capacity = Math.max(0, (this.options.concurrency?.() ?? 2) - this.running.size);
      if (capacity <= 0) return;
      const items = this.options.workers.listDispatchable().slice(0, capacity);
      for (const item of items) {
        const task = this.dispatch(item).finally(() => this.tasks.delete(task));
        this.tasks.add(task);
      }
    } finally {
      this.ticking = false;
    }
  }

  async cancel(workItemId: string): Promise<void> {
    const running = this.running.get(workItemId);
    if (running) {
      await running.handle.stop().catch(() => {});
      const attempt = this.options.workers.getAttempt(running.attemptId);
      const item = this.options.workers.getItem(workItemId);
      if (item.activeAttemptId === attempt.id) {
        this.options.workers.finishAttempt(attempt.id, attempt.fence, "CANCELLED");
      }
    }
  }

  async recover(): Promise<void> {
    for (const attempt of this.options.workers.listActiveAttempts()) {
      if (attempt.role === "plan") this.options.workers.releasePlanningAfterCrash(attempt.id);
      else await this.recoverExecution(attempt.id);
    }
  }

  private async dispatch(item: ManagedWorkItem): Promise<void> {
    const role = item.status === "PLANNING" ? "plan" : "execute";
    const budget = this.options.budgetUsd?.() ?? Number.POSITIVE_INFINITY;
    if (this.options.workers.costForWorkItem(item.id) >= budget) {
      this.options.workers.blockWithoutAttempt(item.id, `WorkItem 已达到模型预算上限 $${budget}`);
      return;
    }
    const attempt = this.options.workers.startAttempt(item.id, role);
    let handle: WorkerHandle | null = null;
    try {
      const workspace = await this.workspaceFor(item);
      const plan = role === "execute" ? this.currentPlan(item) : null;
      handle = await this.options.runner.start(
        { attempt, item: this.options.workers.getItem(item.id), workspace, plan, model: this.options.model },
        (seq, type, payload) => {
          if (type === "session.file") {
            const sessionFile = (payload as { sessionFile?: unknown }).sessionFile;
            if (typeof sessionFile === "string")
              this.options.workers.saveSessionFile(attempt.id, attempt.fence, sessionFile);
            return;
          }
          this.options.workers.appendEvent(attempt.id, attempt.fence, seq, type, payload);
        },
      );
      this.running.set(item.id, { attemptId: attempt.id, handle });
      this.options.workers.attachWorker(attempt.id, attempt.fence, handle.pid, workspace);
      const outcome = await handle.done;
      this.storeLog(item.id, outcome.logPath);
      if (role === "plan") {
        if (!outcome.planContent)
          throw new Error(outcome.question ? "计划 Worker 有需要人工回答的问题" : "计划 Worker 未调用 WritePlan");
        const verification = planSection(outcome.planContent, ["验证命令", "Verification", "Verification Commands"]);
        const changeScope = planSection(outcome.planContent, ["拟改范围", "Change Scope", "Scope"]);
        if (verification.length === 0) throw new Error("计划缺少“验证命令”二级章节，不能进入审批");
        this.options.engine.execute(
          {
            type: "plan.submit",
            workItemId: item.id,
            content: outcome.planContent,
            baseSha: workspace.baseSha,
            verification,
            ...(changeScope.length ? { changeScope } : { changeScope: ["见计划内容"] }),
            risk: outcome.question ? "有待回答问题" : "",
          },
          "local-device",
        );
        this.options.workers.finishAttempt(attempt.id, attempt.fence, "COMPLETED");
        const planRecord = this.options.store.snapshot().plans.find((candidate) => candidate.workItemId === item.id);
        if (this.options.artifacts && planRecord) {
          const artifact = this.options.artifacts.put({
            workItemId: item.id,
            kind: "plan",
            content: outcome.planContent,
            mimeType: "text/markdown",
            metadata: { planHash: planRecord.planHash },
          });
          this.options.store.db
            .prepare("UPDATE plan_revisions SET artifact_id = ? WHERE id = ?")
            .run(artifact.id, planRecord.id);
        }
        return;
      }

      const report = outcome.report;
      if (!report) throw new Error("执行 Worker 未调用 ReportWork");
      this.options.workers.recordReport(attempt.id, attempt.fence, report);
      if (report.status !== "ready") {
        const status = report.status === "failed" ? "FAILED" : "BLOCKED";
        this.options.workers.setStatus(attempt.id, attempt.fence, status, report.summary);
        this.options.workers.finishAttempt(attempt.id, attempt.fence, "FAILED");
        return;
      }
      if (!plan) throw new Error("执行 Attempt 缺少已批准计划");
      this.options.workers.setStatus(attempt.id, attempt.fence, "VALIDATING");
      const tests = [] as WorkerWorkReport["tests"];
      for (const command of plan.verification) tests.push(await runVerification(command, workspace.worktreePath));
      const verifiedReport: WorkerWorkReport = { ...report, tests };
      this.options.workers.recordReport(attempt.id, attempt.fence, verifiedReport);
      this.options.artifacts?.put({
        workItemId: item.id,
        kind: "test-report",
        content: JSON.stringify(verifiedReport, null, 2),
        mimeType: "application/json",
      });
      if (tests.length === 0 || tests.some((test) => test.status !== "passed")) {
        this.options.workers.setStatus(attempt.id, attempt.fence, "FAILED", "批准计划中的验证命令失败");
        this.options.workers.finishAttempt(attempt.id, attempt.fence, "FAILED");
        return;
      }
      this.options.workers.setStatus(attempt.id, attempt.fence, "COMMITTING");
      const current = this.options.workers.getItem(item.id);
      if (current.activeAttemptId !== attempt.id) throw new Error("commit 前 fence/activeAttempt 已变化");
      const committed = await this.options.git.commit(workspace, report.commitMessage ?? `功能: ${item.title}`);
      const diffArtifact = this.options.artifacts?.put({
        workItemId: item.id,
        kind: "diff",
        content: `${committed.diff.stat}\n\n${committed.diff.patch}\n`,
        mimeType: "text/x-diff",
      });
      if (diffArtifact) {
        this.options.store.db
          .prepare("UPDATE work_items SET diff_artifact_id = ? WHERE id = ?")
          .run(diffArtifact.id, item.id);
      }
      this.options.afterCommit?.();
      this.options.workers.completeCommit(attempt.id, attempt.fence, committed.sha, committed.diff, verifiedReport);
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)), item.id);
      if (error instanceof InjectedWorkerFault) {
        this.options.onFault?.(error);
        return; // 保留 COMMITTING 与活跃 Attempt，模拟控制面在回执前崩溃。
      }
      const current = this.options.workers.getItem(item.id);
      if (current.activeAttemptId !== attempt.id) return;
      if (error instanceof GitWorkspaceError && error.code === "UNEXPECTED_HEAD") {
        if (role === "plan") this.options.workers.releasePlanningAfterCrash(attempt.id);
        else await this.recoverExecution(attempt.id);
      } else if (/Worker 异常退出|Worker ready 超时|Worker 已停止/.test(String(error))) {
        if (role === "plan") this.options.workers.releasePlanningAfterCrash(attempt.id);
        else await this.recoverExecution(attempt.id);
      } else if (current.status === "COMMITTING" || current.status === "RECOVERING") {
        await this.recoverExecution(attempt.id);
      } else {
        const status =
          current.status === "PLANNING" || current.status === "RUNNING" || current.status === "VALIDATING"
            ? "FAILED"
            : null;
        if (status)
          this.options.workers.setStatus(
            attempt.id,
            attempt.fence,
            status,
            error instanceof Error ? error.message : String(error),
          );
        this.options.workers.finishAttempt(attempt.id, attempt.fence, "FAILED");
      }
    } finally {
      if (handle) await handle.stop().catch(() => {});
      this.running.delete(item.id);
    }
  }

  private storeLog(workItemId: string, logPath: string): void {
    if (!this.options.artifacts || !existsSync(logPath)) return;
    const content = readFileSync(logPath);
    if (content.byteLength === 0) return;
    const tail = content.subarray(Math.max(0, content.byteLength - 16 * 1024 * 1024));
    const artifact = this.options.artifacts.put({
      workItemId,
      kind: "worker-log",
      content: tail,
      mimeType: "text/plain",
      metadata: { truncated: content.byteLength > tail.byteLength },
    });
    const attemptId = this.options.workers.getItem(workItemId).activeAttemptId;
    if (attemptId)
      this.options.store.db.prepare("UPDATE attempts SET log_artifact_id = ? WHERE id = ?").run(artifact.id, attemptId);
  }

  private async workspaceFor(item: ManagedWorkItem): Promise<GitWorkspace> {
    if (item.worktreePath && item.branch && item.baseSha && existsSync(item.worktreePath)) {
      const workspace = await this.options.git.inspect(item.worktreePath, item.branch, item.baseSha);
      return { ...workspace, workItemId: item.id, repo: item.repo };
    }
    return this.options.git.prepare(item.id, item.repo);
  }

  private currentPlan(item: ManagedWorkItem): PlanRevision {
    const plan = this.options.store.snapshot().plans.find((candidate) => candidate.id === item.currentPlanId);
    if (plan?.status !== "APPROVED") throw new Error("没有已批准 PlanRevision");
    return plan;
  }

  private async recoverExecution(attemptId: string): Promise<void> {
    const attempt = this.options.workers.getAttempt(attemptId);
    const item = this.options.workers.getItem(attempt.workItemId);
    if (item.status === "COMPLETED" || item.status === "CANCELLED") return;
    this.options.workers.markExecutionRecovering(attemptId);
    if (!item.worktreePath || !item.branch || !item.baseSha || !existsSync(item.worktreePath)) {
      this.options.workers.finishReconciliation(attemptId, {
        status: "clean-base",
        detail: "Worker 尚未附着 worktree",
      });
      return;
    }
    const workspace = await this.options.git.inspect(item.worktreePath, item.branch, item.baseSha);
    const result = await this.options.git.reconcile({ ...workspace, workItemId: item.id, repo: item.repo });
    if (result.status === "committed") {
      if (!result.commitSha) throw new Error("commit 对账缺少 SHA");
      const diff = item.diff ?? (await this.options.git.diff({ ...workspace, workItemId: item.id, repo: item.repo }));
      const report: WorkerWorkReport = item.report ?? {
        status: "ready",
        summary: "commit 后回执前中断；由实际 HEAD、基线和工作区状态对账恢复",
        tests: [],
      };
      this.options.workers.completeCommit(attemptId, attempt.fence, result.commitSha, diff, report);
      return;
    }
    this.options.workers.finishReconciliation(attemptId, { status: result.status, detail: result.detail });
  }
}
