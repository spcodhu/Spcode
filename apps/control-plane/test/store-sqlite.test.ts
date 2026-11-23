import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SuperAgentCommand } from "@spcode/shared/superagent";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSuperAgentStore } from "../src/store-sqlite.js";

const homes: string[] = [];
function store(): SqliteSuperAgentStore {
  const home = mkdtempSync(join(tmpdir(), "spcode-control-test-"));
  homes.push(home);
  return new SqliteSuperAgentStore(join(home, "control.sqlite"));
}

function create(requestId = "req_1"): Extract<SuperAgentCommand, { type: "workitem.create" }> {
  return { type: "workitem.create", requestId, repo: "spcodhu/Spcode", title: "实现功能", request: "完成并验证" };
}

function submit(
  workItemId: string,
  content = "# 计划\n\n修改并测试。",
): Extract<SuperAgentCommand, { type: "plan.submit" }> {
  return {
    type: "plan.submit",
    workItemId,
    content,
    baseSha: "a8ad263",
    verification: ["pnpm test"],
    changeScope: ["apps/control-plane/**"],
  };
}

afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe("SQLite SuperAgent 事实库", () => {
  it("重复 Trigger 幂等，同 key 不同内容失败关闭", () => {
    const db = store();
    const first = db.execute(create(), "local-device");
    const second = db.execute(create(), "local-device");
    expect(second.workItemId).toBe(first.workItemId);
    expect(db.snapshot().workItems).toHaveLength(1);
    expect(() => db.execute({ ...create(), request: "另一份需求" }, "local-device")).toThrow(/不同内容/);
    db.close();
  });

  it("计划、批准、Run 与审计在一个事务中推进", () => {
    const db = store();
    const { workItemId } = db.execute(create(), "local-device");
    db.execute(submit(workItemId!), "local-device");
    const pending = db.snapshot();
    const plan = pending.plans[0]!;
    expect(pending.workItems[0]!.status).toBe("AWAITING_PLAN_APPROVAL");
    db.execute(
      { type: "plan.approve", workItemId: workItemId!, planId: plan.id, planHash: plan.planHash },
      "local-device",
    );
    const approved = db.snapshot();
    expect(approved.workItems[0]!.status).toBe("QUEUED");
    expect(approved.plans[0]!.status).toBe("APPROVED");
    expect(Number(db.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n)).toBe(1);
    expect(approved.audit.map((entry) => entry.action)).toContain("plan.approve");
    db.execute(
      { type: "plan.approve", workItemId: workItemId!, planId: plan.id, planHash: plan.planHash },
      "local-device",
    );
    expect(Number(db.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n)).toBe(1);
    db.close();
  });

  it("修订计划后旧卡不能批准", () => {
    const db = store();
    const { workItemId } = db.execute(create(), "local-device");
    db.execute(submit(workItemId!), "local-device");
    const oldPlan = db.snapshot().plans[0]!;
    db.execute(submit(workItemId!, "# 新计划\n\n范围已经变化"), "local-device");
    expect(db.snapshot().plans.find((plan) => plan.id === oldPlan.id)?.status).toBe("SUPERSEDED");
    expect(() =>
      db.execute(
        { type: "plan.approve", workItemId: workItemId!, planId: oldPlan.id, planHash: oldPlan.planHash },
        "local-device",
      ),
    ).toThrow(/current/);
    expect(Number(db.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n)).toBe(0);
    db.close();
  });

  it("数据库重启后计划与审批事实仍在，WAL/外键/版本生效", () => {
    const db = store();
    const file = db.file;
    const { workItemId } = db.execute(create(), "local-device");
    db.execute(submit(workItemId!), "local-device");
    db.close();
    const reopened = new SqliteSuperAgentStore(file);
    expect(reopened.snapshot().workItems[0]?.status).toBe("AWAITING_PLAN_APPROVAL");
    expect(reopened.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys).toBe(1);
    expect(reopened.db.prepare("PRAGMA user_version").get()!.user_version).toBe(2);
    expect(String(reopened.db.prepare("PRAGMA journal_mode").get()!.journal_mode).toLowerCase()).toBe("wal");
    reopened.close();
  });

  it("取消持久化 STOPPED，不允许取消后重新派工", () => {
    const db = store();
    const { workItemId } = db.execute(create(), "local-device");
    db.execute({ type: "workitem.cancel", workItemId: workItemId! }, "local-device");
    const item = db.snapshot().workItems[0]!;
    expect(item.status).toBe("CANCELLED");
    expect(item.desiredState).toBe("STOPPED");
    expect(() => db.execute(submit(workItemId!), "local-device")).toThrow(/当前状态/);
    db.close();
  });
});
