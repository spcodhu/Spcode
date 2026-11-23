import type { WorkItemState } from "@spcode/shared/superagent";

const TRANSITIONS: Record<WorkItemState, readonly WorkItemState[]> = {
  PLANNING: ["AWAITING_PLAN_APPROVAL", "BLOCKED", "FAILED", "CANCELLED"],
  AWAITING_PLAN_APPROVAL: ["PLANNING", "QUEUED", "CANCELLED"],
  QUEUED: ["RUNNING", "BLOCKED", "CANCELLED"],
  RUNNING: ["VALIDATING", "BLOCKED", "FAILED", "CANCELLED", "RECOVERING"],
  VALIDATING: ["COMMITTING", "BLOCKED", "FAILED", "CANCELLED", "RECOVERING"],
  COMMITTING: ["COMPLETED", "RECOVERING", "CANCELLED"],
  COMPLETED: [],
  BLOCKED: ["QUEUED", "CANCELLED"],
  FAILED: ["QUEUED", "CANCELLED"],
  CANCELLED: [],
  RECOVERING: ["QUEUED", "AWAITING_RECONCILIATION", "FAILED", "CANCELLED"],
  AWAITING_RECONCILIATION: ["QUEUED", "COMPLETED", "FAILED", "CANCELLED"],
};

export function canTransition(from: WorkItemState, to: WorkItemState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertTransition(from: WorkItemState, to: WorkItemState): void {
  if (!canTransition(from, to)) throw new Error(`Invalid WorkItem transition: ${from} -> ${to}`);
}

/** 等待审批与人工作业不持有执行租约，Watchdog 和派工器共用这一事实。 */
export function holdsExecutionLease(state: WorkItemState): boolean {
  return state === "QUEUED" || state === "RUNNING" || state === "VALIDATING" || state === "COMMITTING";
}

export function isTerminalState(state: WorkItemState): boolean {
  return state === "COMPLETED" || state === "CANCELLED";
}
