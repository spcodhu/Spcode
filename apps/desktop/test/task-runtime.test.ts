/**
 * 子任务预算树与工作区写入租约专项（纯调度，不起模型）：
 * 共享预算原子预占、总结票、并发槽、等待子任务释放槽、取消传播；
 * writer FIFO、同主体重入、持锁禁止等待写子任务。
 */

import { intersectTaskPermissionMode, TaskTree, taskRoleAllowsTool } from "@spcode/agent-runtime/task-runtime.js";
import { abortError, WorkspaceWriterManager } from "@spcode/agent-runtime/workspace-writer.js";
import { normalizeTaskLimits } from "@spcode/shared/task-runtime";
import { describe, expect, it } from "vitest";

describe("任务预算", () => {
  it("设置只能收紧默认上限，不能解除有限预算", () => {
    const limits = normalizeTaskLimits({ childTurns: 99999, activeTasks: 1 });
    expect(limits.childTurns).toBe(64);
    expect(limits.activeTasks).toBe(1);
    expect(normalizeTaskLimits({ childTurns: 8 }).childTurns).toBe(8);
  });

  it("最后一票为总结票；耗尽后停止；子树共享预算", () => {
    const tree = new TaskTree({ getTaskLimits: () => ({ childTurns: 2, treeTurns: 3 }) });
    const child = tree.createChild(tree.root, "readonly");
    expect(child.reserveTurn()).toBe("work");
    expect(child.reserveTurn()).toBe("summary");
    expect(child.reserveTurn()).toBe("stop");
    // 兄弟子任务共享树预算：树已用 2（child 两票），树上限 3 → 仅剩 1 票总结
    const sibling = tree.createChild(tree.root, "readonly");
    expect(sibling.reserveTurn()).toBe("summary");
    expect(sibling.reserveTurn()).toBe("stop");
    tree.dispose();
  });

  it("80% 提醒只发一次；取消向后代传播", () => {
    const warnings: string[] = [];
    const tree = new TaskTree({
      getTaskLimits: () => ({ childTurns: 5 }),
      onWarning: (id) => warnings.push(id),
    });
    const child = tree.createChild(tree.root, "readonly");
    for (let i = 0; i < 4; i++) child.reserveTurn();
    expect(warnings).toHaveLength(1);
    const grand = tree.createChild(child, "readonly");
    tree.cancel();
    expect(child.signal.aborted).toBe(true);
    expect(grand.signal.aborted).toBe(true);
    tree.dispose();
  });

  it("并发槽上限与等待子任务时释放槽", async () => {
    const tree = new TaskTree({ getTaskLimits: () => ({ activeTasks: 1 }) });
    const a = tree.createChild(tree.root, "readonly");
    const b = tree.createChild(tree.root, "readonly");
    await a.acquireActiveSlot();
    let bAcquired = false;
    const pending = b.acquireActiveSlot().then(() => {
      bAcquired = true;
    });
    await Promise.resolve();
    expect(bAcquired).toBe(false);
    // a 等待子任务期间释放槽 → b 可运行；b 完成后释放，a 重新取槽
    await a.whileWaitingForChild(async () => {
      await pending;
      expect(bAcquired).toBe(true);
      b.dispose();
    });
    expect(tree.activeCount).toBe(1);
    tree.dispose();
  });

  it("角色能力上限：只读不开放 Shell/写；权限取交集且不随父级放宽", () => {
    expect(taskRoleAllowsTool("readonly", "bash")).toBe(false);
    expect(taskRoleAllowsTool("readonly", "ReadEvidence")).toBe(true);
    expect(taskRoleAllowsTool("write", "edit")).toBe(true);
    expect(taskRoleAllowsTool("readonly", "Task", { role: "write" })).toBe(false);
    expect(intersectTaskPermissionMode("ask", "never")).toBe("ask");
    expect(intersectTaskPermissionMode("auto", "ask")).toBe("ask");
  });
});

describe("工作区写入租约", () => {
  it("FIFO 串行；同主体重入；释放后交给排队者", async () => {
    const manager = new WorkspaceWriterManager();
    const ownerA = { principalId: "a" };
    const ownerB = { principalId: "b" };
    const leaseA = await manager.acquire("/ws", ownerA);
    let bGot = false;
    const pendingB = manager.acquire("/ws", ownerB).then((lease) => {
      bGot = true;
      return lease;
    });
    await Promise.resolve();
    expect(bGot).toBe(false);
    // 同主体重入不阻塞
    const reentrant = await manager.acquire("/ws", ownerA);
    reentrant.release();
    leaseA.release();
    const leaseB = await pendingB;
    expect(bGot).toBe(true);
    leaseB.release();
    expect(manager.heldCount).toBe(0);
  });

  it("持写锁的任务不得等待写子任务（防死锁），只读子任务允许", async () => {
    const manager = new WorkspaceWriterManager();
    const parent = { principalId: "p" };
    const lease = await manager.acquire("/ws", parent);
    const writeChild = { principalId: "c", ancestorIds: ["p"] };
    await expect(manager.acquire("/ws", writeChild)).rejects.toThrow(/writer cannot wait/i);
    lease.release();
  });

  it("排队中取消立即退出，不占用租约", async () => {
    const manager = new WorkspaceWriterManager();
    const lease = await manager.acquire("/ws", { principalId: "a" });
    const controller = new AbortController();
    const pending = manager.acquire("/ws", { principalId: "b" }, controller.signal);
    controller.abort(abortError());
    await expect(pending).rejects.toThrow();
    expect(manager.pendingCount).toBe(0);
    lease.release();
  });
});
