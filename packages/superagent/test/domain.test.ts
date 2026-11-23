import type { PlanRevision, WorkItem } from "@spcode/shared/superagent";
import { describe, expect, it } from "vitest";
import { assertPlanApproval, assertTransition, canTransition, holdsExecutionLease, isAuthorizedSource } from "../src/index.js";

const workItem: WorkItem = {
  id: "wi_1",
  triggerId: "tr_1",
  repo: "spcodhu/Spcode",
  title: "测试",
  request: "完成测试",
  status: "AWAITING_PLAN_APPROVAL",
  desiredState: "ACTIVE",
  currentPlanId: "pl_1",
  activeAttemptId: null,
  createdAt: 1,
  updatedAt: 1,
};

const plan: PlanRevision = {
  id: "pl_1",
  workItemId: "wi_1",
  revision: 1,
  content: "计划",
  planHash: "abc",
  baseSha: "0123",
  verification: ["pnpm test"],
  changeScope: ["src/**"],
  publishIntent: false,
  effectIntent: [],
  risk: "",
  status: "PENDING",
  createdAt: 1,
};

describe("WorkItem 状态机", () => {
  it("等待审批不持租约，取消是终态", () => {
    expect(holdsExecutionLease("AWAITING_PLAN_APPROVAL")).toBe(false);
    expect(canTransition("CANCELLED", "QUEUED")).toBe(false);
    expect(() => assertTransition("PLANNING", "RUNNING")).toThrow();
  });

  it("提交计划后先等待批准，再进入队列", () => {
    expect(canTransition("PLANNING", "AWAITING_PLAN_APPROVAL")).toBe(true);
    expect(canTransition("AWAITING_PLAN_APPROVAL", "QUEUED")).toBe(true);
  });
});

describe("计划审批 Gate", () => {
  it("接受当前 planHash 和已授权操作者", () => {
    expect(() =>
      assertPlanApproval({ actorId: "local", authorized: true, workItem, plan, presentedPlanHash: "abc" }),
    ).not.toThrow();
  });

  it("拒绝旧哈希和非当前修订", () => {
    expect(() =>
      assertPlanApproval({ actorId: "local", authorized: true, workItem, plan, presentedPlanHash: "old" }),
    ).toThrow(/hash/);
    expect(() =>
      assertPlanApproval({
        actorId: "local",
        authorized: true,
        workItem: { ...workItem, currentPlanId: "pl_2" },
        plan,
        presentedPlanHash: "abc",
      }),
    ).toThrow(/current/);
  });
});

describe("Source Gate", () => {
  const input = {
    enabled: true,
    chatId: "chat",
    operatorId: "user",
    allowedChats: ["chat"],
    authorizedOperators: ["user"],
    mentionedBot: true,
    fromBot: false,
  };

  it("只接受授权群、授权人、真实 @ 且非机器人消息", () => {
    expect(isAuthorizedSource(input)).toBe(true);
    expect(isAuthorizedSource({ ...input, mentionedBot: false })).toBe(false);
    expect(isAuthorizedSource({ ...input, operatorId: "other" })).toBe(false);
    expect(isAuthorizedSource({ ...input, fromBot: true })).toBe(false);
  });
});
