import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSuperAgentStore } from "../src/store-sqlite.js";
import { ThreadService } from "../src/thread-service.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("连续 Thread", () => {
  it("CI 只进 Mailbox，人的需求产生新 PlanRevision，停止不被唤醒", () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-thread-test-"));
    const store = new SqliteSuperAgentStore(join(home, "control.sqlite"));
    const threads = new ThreadService(store);
    cleanups.push(() => {
      store.close();
      rmSync(home, { recursive: true, force: true });
    });
    const { workItemId } = store.execute(
      { type: "workitem.create", requestId: "req_thread", repo: "owner/repo", title: "Thread", request: "连续需求" },
      "local-device",
    );
    store.execute(
      {
        type: "plan.submit",
        workItemId: workItemId!,
        content: "初版计划",
        baseSha: "abc",
        verification: ["pnpm test"],
        changeScope: ["src/**"],
      },
      "local-device",
    );
    const plan = store.snapshot().plans[0]!;
    store.execute(
      { type: "plan.approve", workItemId: workItemId!, planId: plan.id, planHash: plan.planHash },
      "local-device",
    );
    expect(
      threads.record({
        source: "github",
        externalEventId: "ci-1",
        threadId: "thread-1",
        workItemId: workItemId!,
        kind: "ci.review",
        actorId: "external:ci",
        payload: { state: "success" },
      }).created,
    ).toBe(true);
    expect(
      threads.record({
        source: "github",
        externalEventId: "human-1",
        threadId: "thread-1",
        workItemId: workItemId!,
        kind: "human.requirement",
        actorId: "external:user",
        payload: { content: "增加新的执行范围" },
      }).created,
    ).toBe(true);
    const revised = store.snapshot();
    expect(revised.plans).toHaveLength(2);
    expect(revised.workItems[0]?.status).toBe("PLANNING");
    expect(revised.plans.find((plan) => plan.revision === 2)?.status).toBe("PENDING");
    expect(revised.plans.find((plan) => plan.revision === 1)?.status).toBe("SUPERSEDED");
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(1);
    expect(
      threads.record({
        source: "github",
        externalEventId: "human-1",
        threadId: "thread-1",
        workItemId: workItemId!,
        kind: "human.requirement",
        actorId: "external:user",
        payload: { content: "重复事件" },
      }).created,
    ).toBe(false);
    const stopped = threads.record({
      source: "github",
      externalEventId: "stop-1",
      threadId: "thread-1",
      workItemId: workItemId!,
      kind: "stop",
      actorId: "external:user",
      payload: {},
    });
    expect(stopped.requiresStop).toBe(true);
    store.execute({ type: "workitem.cancel", workItemId: workItemId! }, "external:user");
    expect(
      threads.record({
        source: "github",
        externalEventId: "human-2",
        threadId: "thread-1",
        workItemId: workItemId!,
        kind: "human.requirement",
        actorId: "external:user",
        payload: { content: "停止后的需求" },
      }).requiresStop,
    ).toBe(false);
    expect(store.snapshot().workItems[0]?.status).toBe("CANCELLED");
    expect(threads.list(workItemId!)).toHaveLength(4);
  });
});
