import type { PlanRevision, WorkItem } from "@spcode/shared/superagent";

export interface ApprovalContext {
  actorId: string;
  authorized: boolean;
  workItem: WorkItem;
  plan: PlanRevision;
  presentedPlanHash: string;
}

/** 审批失败关闭：旧卡、跨 WorkItem 卡、非当前修订和非授权主体一律拒绝。 */
export function assertPlanApproval(context: ApprovalContext): void {
  if (!context.authorized) throw new Error("Actor is not authorized to approve plans");
  if (context.workItem.desiredState === "STOPPED" || context.workItem.status === "CANCELLED") {
    throw new Error("Cancelled WorkItem cannot be approved");
  }
  if (context.plan.workItemId !== context.workItem.id) throw new Error("Plan belongs to another WorkItem");
  if (context.workItem.currentPlanId !== context.plan.id || context.plan.status !== "PENDING") {
    throw new Error("Plan revision is no longer current");
  }
  if (context.workItem.status !== "AWAITING_PLAN_APPROVAL") {
    throw new Error("WorkItem is not awaiting plan approval");
  }
  if (context.presentedPlanHash !== context.plan.planHash)
    throw new Error("Plan hash does not match the approved revision");
}

/** Issue、评论和 IM 文本只是输入；只有确定性 Gate 返回的授权才可创建 Trigger。 */
export function isAuthorizedSource(input: {
  enabled: boolean;
  chatId: string;
  operatorId: string;
  allowedChats: string[];
  authorizedOperators: string[];
  mentionedBot: boolean;
  fromBot: boolean;
}): boolean {
  return (
    input.enabled &&
    !input.fromBot &&
    input.mentionedBot &&
    input.allowedChats.includes(input.chatId) &&
    input.authorizedOperators.includes(input.operatorId)
  );
}
