/** Shared, synchronous reservation ledger for one user prompt's entire Task tree.
 * No await occurs between checking and consuming a turn. Retries/compaction are
 * actual usage, not extra work turns; wall time includes initialization/queues/approval.
 */
import { randomUUID } from "node:crypto";
import type { PermissionMode, UsageRecord } from "@spcode/shared";
import {
  normalizeTaskLimits,
  type TaskBudgetRequest,
  type TaskLimits,
  type TaskRole,
  type TaskUsage,
} from "@spcode/shared/task-runtime";
import { abortError, type WorkspaceWriterOwner } from "./workspace-writer.js";

export type TaskStopReason = "cancelled" | "timeout" | "budget" | "repeatTool";
export type TaskTurnReservation = "work" | "summary" | "stop";
export interface TaskUsageRecord extends UsageRecord {
  usageId: string;
  taskId: string;
  taskSource: "work" | "summary" | "compaction";
}
export interface TaskRuntimeOptions {
  getTaskLimits?: () => Partial<TaskLimits>;
  emitUsage?: (usage: TaskUsageRecord) => void;
  onWarning?: (taskId: string, message: string) => void;
}

const emptyUsage = (): TaskUsage => ({
  turns: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costTotal: 0,
  requests: 0,
  auxiliaryRequests: 0,
});
const modeRank: Record<PermissionMode, number> = { ask: 0, auto: 1, never: 2 };
export function intersectTaskPermissionMode(cap: PermissionMode, live: PermissionMode): PermissionMode {
  return modeRank[cap] <= modeRank[live] ? cap : live;
}

const readTools = new Set(["read", "grep", "find", "ls", "readevidence"]);
const writeTools = new Set([...readTools, "edit", "write", "bash", "powershell"]);
export function taskRoleAllowsTool(role: TaskRole, name: string, args?: unknown): boolean {
  const tool = name.toLowerCase();
  if (tool === "task") {
    return role === "write" || (args as { role?: unknown } | undefined)?.role !== "write";
  }
  return (role === "readonly" ? readTools : writeTools).has(tool);
}

interface SlotWaiter {
  run: TaskRun;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  abort: () => void;
}

export class TaskTree {
  readonly limits: TaskLimits;
  readonly root: TaskRun;
  private active = 0;
  private readonly queue: SlotWaiter[] = [];
  private readonly usageIds = new Set<string>();

  constructor(
    readonly options: TaskRuntimeOptions = {},
    signal?: AbortSignal,
  ) {
    this.limits = normalizeTaskLimits(options.getTaskLimits?.());
    this.root = new TaskRun(
      this,
      undefined,
      "write",
      this.limits.treeTurns,
      Date.now() + this.limits.treeWallTimeMs,
      signal,
    );
  }

  createChild(
    parent: TaskRun = this.root,
    role: TaskRole = "readonly",
    budget?: TaskBudgetRequest,
    signal?: AbortSignal,
  ) {
    parent.assertLive();
    if (parent.depth >= this.limits.maxDepth) throw new Error("Task depth limit reached");
    if (parent.role === "readonly" && role === "write") throw new Error("Readonly Tasks cannot create write children");
    const lower = (n: number | undefined, cap: number) =>
      typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? Math.min(n, cap) : cap;
    return new TaskRun(
      this,
      parent,
      role,
      lower(budget?.maxTurns, this.limits.childTurns),
      Math.min(parent.deadline, Date.now() + lower(budget?.wallTimeMs, this.limits.childWallTimeMs)),
      signal,
    );
  }

  acquireSlot(run: TaskRun): Promise<() => void> {
    run.assertLive();
    // The foreground root is not a child execution slot.
    if (run === this.root) return Promise.resolve(() => {});
    if (this.active < this.limits.activeTasks) return Promise.resolve(this.slot());
    return new Promise((resolve, reject) => {
      const waiter: SlotWaiter = {
        run,
        resolve,
        reject,
        abort: () => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) this.queue.splice(i, 1);
          run.signal.removeEventListener("abort", waiter.abort);
          reject(abortError());
        },
      };
      this.queue.push(waiter);
      run.signal.addEventListener("abort", waiter.abort, { once: true });
      if (run.signal.aborted) waiter.abort();
    });
  }

  private slot(): () => void {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      let next = this.queue.shift();
      while (next?.run.signal.aborted) {
        next.run.signal.removeEventListener("abort", next.abort);
        next.reject(abortError());
        next = this.queue.shift();
      }
      if (next) {
        next.run.signal.removeEventListener("abort", next.abort);
        next.resolve(this.slot());
      }
    };
  }

  /** Stream-level records are the sole billing events. TaskResult.usage is never emitted. */
  recordUsage(run: TaskRun, record: TaskUsageRecord): void {
    if (this.usageIds.has(record.usageId)) return;
    this.usageIds.add(record.usageId);
    for (const ancestor of run.lineage) {
      const u = ancestor.usage;
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "costTotal"] as const) u[key] += record[key];
      u.requests++;
      if (record.taskSource === "compaction") u.auxiliaryRequests++;
    }
    this.options.emitUsage?.(record);
  }

  cancel(reason: TaskStopReason = "cancelled"): void {
    this.root.cancel(reason);
  }
  dispose(): void {
    this.root.dispose();
  }
  get activeCount(): number {
    return this.active;
  }
  get pendingCount(): number {
    return this.queue.length;
  }
}

export class TaskRun {
  readonly id = randomUUID();
  readonly depth: number;
  readonly usage = emptyUsage();
  readonly controller = new AbortController();
  readonly children = new Set<TaskRun>();
  readonly owner: WorkspaceWriterOwner;
  readonly lineage: readonly TaskRun[];
  readonly signal = this.controller.signal;
  stopReason?: TaskStopReason;
  summaryStarted = false;
  warningIssued = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly removeListeners: (() => void)[] = [];
  private releaseSlot?: () => void;
  private slotPromise?: Promise<void>;
  private waitingChildren = 0;
  private disposed = false;

  constructor(
    readonly tree: TaskTree,
    readonly parent: TaskRun | undefined,
    readonly role: TaskRole,
    readonly maxTurns: number,
    readonly deadline: number,
    externalSignal?: AbortSignal,
  ) {
    this.depth = parent ? parent.depth + 1 : 0;
    this.lineage = [this, ...(parent?.lineage ?? [])];
    this.owner = { principalId: this.id, ancestorIds: parent?.lineage.map((run) => run.id) ?? [] };
    parent?.children.add(this);
    for (const signal of [parent?.signal, externalSignal]) {
      if (!signal) continue;
      const abort = () => this.cancel(parent?.stopReason === "timeout" ? "timeout" : "cancelled");
      signal.addEventListener("abort", abort, { once: true });
      this.removeListeners.push(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    }
    if (!this.signal.aborted) {
      this.timer = setTimeout(() => this.cancel("timeout"), Math.max(0, deadline - Date.now()));
      this.timer.unref?.();
    }
  }

  assertLive(): void {
    if (this.disposed || this.signal.aborted) throw abortError();
    if (Date.now() >= this.deadline) {
      this.cancel("timeout");
      throw abortError();
    }
  }

  get remainingTurns(): number {
    return Math.max(0, Math.min(...this.lineage.map((run) => run.maxTurns - run.usage.turns)));
  }

  /** Called immediately before every work request; the final ticket is summary-only. */
  reserveTurn(): TaskTurnReservation {
    this.assertLive();
    if (this.summaryStarted || this.remainingTurns <= 0) {
      this.stopReason ??= "budget";
      return "stop";
    }
    const kind = this.remainingTurns === 1 || this.stopReason === "repeatTool" ? "summary" : "work";
    for (const run of this.lineage) run.usage.turns++;
    if (kind === "summary") {
      this.summaryStarted = true;
      this.stopReason ??= "budget";
    }
    for (const run of this.lineage) {
      if (!run.warningIssued && run.usage.turns >= Math.ceil(run.maxTurns * 0.8)) {
        run.warningIssued = true;
        this.tree.options.onWarning?.(
          run.id,
          "Task budget is at least 80% consumed. Finish or hand back unresolved work.",
        );
      }
    }
    return kind;
  }

  async acquireActiveSlot(): Promise<void> {
    this.assertLive();
    if (this.releaseSlot) return;
    if (!this.slotPromise) {
      this.slotPromise = this.tree
        .acquireSlot(this)
        .then((release) => {
          if (this.signal.aborted || this.disposed) {
            release();
            throw abortError();
          }
          this.releaseSlot = release;
        })
        .finally(() => {
          this.slotPromise = undefined;
        });
    }
    await this.slotPromise;
  }

  /** Child sessions run sequential tool batches, so waiting on a Task owns no other
   * active tool. Root callers may use this with concurrent children as well.
   */
  async whileWaitingForChild<T>(work: () => Promise<T>): Promise<T> {
    this.assertLive();
    this.waitingChildren++;
    this.releaseSlot?.();
    this.releaseSlot = undefined;
    try {
      return await work();
    } finally {
      this.waitingChildren--;
      if (!this.waitingChildren && !this.signal.aborted && !this.disposed) await this.acquireActiveSlot();
    }
  }

  cancel(reason: TaskStopReason = "cancelled"): void {
    if (this.signal.aborted) return;
    this.stopReason = reason;
    this.controller.abort(abortError());
    for (const child of this.children) child.cancel(reason);
  }

  /** Invoke only after execution has settled; never release a live write's slot early. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    if (this.timer) clearTimeout(this.timer);
    for (const remove of this.removeListeners.splice(0)) remove();
    this.releaseSlot?.();
    this.releaseSlot = undefined;
    this.parent?.children.delete(this);
  }
}

/** Controller integration: start once per new user prompt (not steering/continuation),
 * pass () => runtime.currentTree to Task, and cancel/dispose on stop/hibernate/dispose.
 * The root's own prepareRequest must reserve runtime.currentTree.root.reserveTurn().
 */
export class TaskRuntime {
  private tree?: TaskTree;
  constructor(private readonly options: TaskRuntimeOptions = {}) {}
  startMainPrompt(signal?: AbortSignal): TaskTree {
    this.tree?.dispose();
    this.tree = new TaskTree(this.options, signal);
    return this.tree;
  }
  get currentTree(): TaskTree {
    return this.tree ?? this.startMainPrompt();
  }
  cancel(): void {
    this.tree?.cancel();
  }
  dispose(): void {
    this.tree?.dispose();
    this.tree = undefined;
  }
}
