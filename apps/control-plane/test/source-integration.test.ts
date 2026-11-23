import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuApiError, type FeishuInboundMessage } from "../src/integrations/feishu/api.js";
import { FakeFeishu } from "../src/integrations/feishu/fake-api.js";
import { FeishuGateway } from "../src/integrations/feishu/gateway.js";
import { InjectedOutboxFault, OutboxDispatcher } from "../src/integrations/feishu/outbox.js";
import { type IssueSnapshot, SourceStore } from "../src/source-store.js";
import { DigestService, FakeGitHub } from "../src/sources/github.js";
import { SqliteSuperAgentStore } from "../src/store-sqlite.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function issue(updatedAt = new Date().toISOString()): IssueSnapshot {
  return {
    id: "1001",
    number: 42,
    title: "修复登录",
    body: "登录失败",
    author: "octocat",
    labels: ["bug"],
    url: "https://github.com/owner/repo/issues/42",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt,
    contentHash: "hash-v1",
  };
}

function fixture(dispatcherOptions: { timeoutMs?: number; afterSend?: () => void } = {}) {
  const home = mkdtempSync(join(tmpdir(), "spcode-source-test-"));
  const base = new SqliteSuperAgentStore(join(home, "control.sqlite"));
  const publish = vi.fn();
  const store = new SourceStore(base.db, base, publish);
  const api = new FakeFeishu();
  const approvePlan = vi.fn();
  const gateway = new FeishuGateway(
    store,
    api,
    () => ({
      enabled: true,
      allowedChats: ["chat-1"],
      authorizedOperators: ["user-1"],
      defaultRepo: "owner/repo",
      botOpenId: "bot-1",
    }),
    approvePlan,
  );
  const dispatcher = new OutboxDispatcher(store, api, dispatcherOptions);
  cleanups.push(() => {
    base.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, base, store, api, gateway, dispatcher, publish, approvePlan };
}

function groupMessage(eventId = "event-1"): FeishuInboundMessage {
  return {
    eventId,
    messageId: `message-${eventId}`,
    chatId: "chat-1",
    chatType: "group",
    operatorOpenId: "user-1",
    text: "@_user_1 owner/repo 请修复这个问题",
    mentions: [{ openId: "bot-1", name: "Spcode", key: "@_user_1" }],
    fromBot: false,
  };
}

describe("GitHub Digest → 飞书卡 → Trigger", () => {
  it("批准前无 WorkItem，卡片鉴权且重复点击幂等", async () => {
    const { base, store, api, gateway, dispatcher } = fixture();
    const github = new FakeGitHub([issue()]);
    const digest = new DigestService(store, github);
    await digest.run({ repo: "owner/repo", chatId: "chat-1", mode: "manual", requestId: "manual-1" });
    expect(base.snapshot().workItems).toHaveLength(0);
    await dispatcher.dispatchOne();
    const sent = api.messages.find((message) => message.kind === "card")!;
    const card = sent.content as { elements: Array<{ actions?: Array<{ value: Record<string, unknown> }> }> };
    const value = card.elements.flatMap((element) => element.actions ?? [])[0]!.value;
    const action = {
      eventId: "card-event-1",
      operatorOpenId: "user-1",
      chatId: "chat-1",
      messageId: sent.messageId,
      value,
    };
    expect((await gateway.handleCard({ ...action, operatorOpenId: "attacker" })).created).toBe(false);
    const first = await gateway.handleCard(action);
    const second = await gateway.handleCard(action);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.workItemId).toBe(first.workItemId);
    expect(base.snapshot().workItems).toHaveLength(1);
    expect(store.listOutbox().filter((item) => item.kind === "workitem.accepted")).toHaveLength(1);
  });

  it("同内容不重复，实质更新可再次进入摘要", async () => {
    const { store } = fixture();
    const github = new FakeGitHub([issue("2026-01-02T00:00:00Z")]);
    let now = Date.parse("2026-01-02T01:00:00Z");
    const digest = new DigestService(store, github, () => now);
    expect(
      (await digest.run({ repo: "owner/repo", chatId: "chat-1", mode: "manual", requestId: "one" })).itemCount,
    ).toBe(1);
    expect(
      (await digest.run({ repo: "owner/repo", chatId: "chat-1", mode: "manual", requestId: "two" })).itemCount,
    ).toBe(0);
    now = Date.parse("2026-01-02T02:00:00Z");
    github.issues = [
      { ...github.issues[0]!, body: "新的复现步骤", contentHash: "hash-v2", updatedAt: "2026-01-02T02:00:00Z" },
    ];
    expect(
      (await digest.run({ repo: "owner/repo", chatId: "chat-1", mode: "manual", requestId: "three" })).itemCount,
    ).toBe(1);
    expect(store.listDigests()).toHaveLength(3);
  });
});

describe("飞书授权群 @ Gate", () => {
  it("只接受授权群/人、真实 @、非 bot；重复 event 只建一个 WorkItem", async () => {
    const { base, store, gateway, dispatcher, api } = fixture();
    const message = groupMessage();
    const first = await gateway.handleMessage(message);
    const second = await gateway.handleMessage(message);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.workItemId).toBe(first.workItemId);
    expect(base.snapshot().workItems).toHaveLength(1);
    expect(store.listOutbox().filter((item) => item.kind === "group.accepted")).toHaveLength(1);
    for (const invalid of [
      { ...message, eventId: "e2", chatId: "other" },
      { ...message, eventId: "e3", operatorOpenId: "other" },
      { ...message, eventId: "e4", mentions: [] },
      { ...message, eventId: "e5", fromBot: true },
    ]) {
      expect((await gateway.handleMessage(invalid)).created).toBe(false);
    }
    expect(base.snapshot().workItems).toHaveLength(1);
    await dispatcher.dispatchOne();
    expect(api.messages.filter((item) => item.kind === "reply")).toHaveLength(1);
  });
  it("同群旧时间戳消息按乱序丢弃，不重复触发", async () => {
    const { base, gateway } = fixture();
    const message = { ...groupMessage("ordered-1"), createTime: 2000 };
    expect((await gateway.handleMessage(message)).created).toBe(true);
    expect((await gateway.handleMessage({ ...groupMessage("ordered-2"), createTime: 1000 })).created).toBe(false);
    expect((await gateway.handleMessage({ ...groupMessage("ordered-3"), createTime: 3000 })).created).toBe(true);
    expect(base.snapshot().workItems).toHaveLength(2);
  });
});

describe("Outbox 重试与 UNKNOWN 对账", () => {
  it("429 可退避重试，成功后才 SENT", async () => {
    const { store, api, dispatcher } = fixture();
    store.insertOutbox({ conversationId: "chat-1", kind: "workitem.accepted", payload: { workItemId: "wi_1" } });
    api.error = new FeishuApiError("rate limited", { retryable: true });
    await dispatcher.dispatchOne();
    const id = store.listOutbox()[0]!.id;
    expect(store.outbox(id)?.status).toBe("RETRY");
    api.error = null;
    store.db.prepare("UPDATE outbox SET next_run_at = 0 WHERE id = ?").run(id);
    await dispatcher.dispatchOne();
    expect(store.outbox(id)?.status).toBe("SENT");
    expect(api.messages).toHaveLength(1);
  });

  it("超时进入 UNKNOWN，不自动重发", async () => {
    const { store, api, dispatcher } = fixture({ timeoutMs: 20 });
    store.insertOutbox({ conversationId: "chat-1", kind: "workitem.accepted", payload: { workItemId: "wi_1" } });
    api.hang = true;
    await dispatcher.dispatchOne();
    expect(store.listOutbox()[0]?.status).toBe("UNKNOWN");
    api.hang = false;
    expect(await dispatcher.dispatchOne()).toBe(false);
    expect(api.messages).toHaveLength(0);
  });

  it("发送后/回执前崩溃，恢复为 UNKNOWN 而非再次发送", async () => {
    const { store, api, dispatcher } = fixture({
      afterSend: () => {
        throw new InjectedOutboxFault("crash");
      },
    });
    store.insertOutbox({ conversationId: "chat-1", kind: "workitem.accepted", payload: { workItemId: "wi_1" } });
    await expect(dispatcher.dispatchOne()).rejects.toThrow("crash");
    expect(store.listOutbox()[0]?.status).toBe("SENDING");
    store.recoverSending();
    expect(store.listOutbox()[0]?.status).toBe("UNKNOWN");
    expect(await dispatcher.dispatchOne()).toBe(false);
    expect(api.messages).toHaveLength(1);
  });
});
