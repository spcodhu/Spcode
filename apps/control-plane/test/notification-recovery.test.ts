import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeFeishu } from "../src/integrations/feishu/fake-api.js";
import { OutboxDispatcher } from "../src/integrations/feishu/outbox.js";
import { SourceStore } from "../src/source-store.js";
import { SqliteSuperAgentStore } from "../src/store-sqlite.js";

const homes: string[] = [];
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe("计划落库后/发卡前恢复", () => {
  it("重启后计划卡只发一次，审批终态更新不重复", async () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-notification-recovery-"));
    homes.push(home);
    const file = join(home, "control.sqlite");
    let base = new SqliteSuperAgentStore(file);
    let sources = new SourceStore(base.db, base, () => {});
    const { workItemId } = base.createSourceWorkItem({
      source: "feishu-group",
      externalEventId: "event-plan-recovery",
      triggerExternalId: "event-plan-recovery",
      actorId: "user-1",
      containerId: "chat-1",
      payloadHash: "hash",
      payload: { text: "计划" },
      repo: "owner/repo",
      title: "计划恢复",
      request: "验证计划通知恢复",
    });
    const created = base.execute(
      {
        type: "plan.submit",
        workItemId,
        content: "# 计划\n\n验证恢复",
        baseSha: "a8ad263",
        verification: ["pnpm test"],
        changeScope: ["src/**"],
      },
      "local-device",
    );
    sources.projectNotifications();
    const plan = base.snapshot().plans[0]!;
    base.close();

    const api = new FakeFeishu();
    base = new SqliteSuperAgentStore(file);
    sources = new SourceStore(base.db, base, () => {});
    sources.projectNotifications();
    const dispatcher = new OutboxDispatcher(sources, api);
    expect(await dispatcher.dispatchOne()).toBe(true);
    expect(api.messages.filter((message) => message.kind === "card")).toHaveLength(1);
    expect(await dispatcher.dispatchOne()).toBe(false);
    expect(api.messages.filter((message) => message.kind === "card")).toHaveLength(1);
    expect(created.eventId).toBeGreaterThan(0);

    base.execute({ type: "plan.approve", workItemId, planId: plan.id, planHash: plan.planHash }, "local-device");
    sources.projectNotifications();
    expect(await dispatcher.dispatchOne()).toBe(true);
    expect(api.messages.filter((message) => message.kind === "update")).toHaveLength(1);
    expect(sources.listOutbox().filter((item) => item.kind === "plan.pending")).toHaveLength(1);
    base.close();
  });

  it("摘要落库后/发卡前重启只发一张摘要卡", async () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-digest-recovery-"));
    homes.push(home);
    const file = join(home, "control.sqlite");
    let base = new SqliteSuperAgentStore(file);
    let sources = new SourceStore(base.db, base, () => {});
    sources.recordDigest({
      scheduleId: "daily:owner/repo",
      localDate: "2026-01-01",
      configVersion: 1,
      repo: "owner/repo",
      issues: [
        {
          id: "issue-1",
          number: 1,
          title: "摘要恢复",
          body: "崩溃恢复",
          author: "octocat",
          labels: [],
          url: "https://github.com/owner/repo/issues/1",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          contentHash: "v1",
        },
      ],
      cursor: "2026-01-02T00:00:00Z",
      chatId: "chat-1",
    });
    base.close();

    const api = new FakeFeishu();
    base = new SqliteSuperAgentStore(file);
    sources = new SourceStore(base.db, base, () => {});
    const dispatcher = new OutboxDispatcher(sources, api);
    expect(await dispatcher.dispatchOne()).toBe(true);
    expect(api.messages).toHaveLength(1);
    expect(await dispatcher.dispatchOne()).toBe(false);
    expect(api.messages).toHaveLength(1);
    base.close();
  });
});
