import type { OutboxRecord, SourceStore } from "../../source-store.js";
import { type FeishuApi, FeishuApiError } from "./api.js";

function button(text: string, type: string, value: Record<string, unknown>): Record<string, unknown> {
  return { tag: "button", text: { tag: "plain_text", content: text }, type, value };
}

function card(title: string, template: string, elements: Record<string, unknown>[]): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: title }, template },
    elements,
  };
}

function markdown(content: string): Record<string, unknown> {
  return { tag: "div", text: { tag: "lark_md", content } };
}

export class InjectedOutboxFault extends Error {}

export class OutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;

  constructor(
    readonly store: SourceStore,
    private readonly api: FeishuApi,
    private readonly options: { timeoutMs?: number; pollMs?: number; afterSend?: () => void } = {},
  ) {}

  start(): void {
    this.stopping = false;
    this.store.recoverSending();
    this.timer = setInterval(() => void this.dispatchOne(), this.options.pollMs ?? 1000);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const deadline = Date.now() + 2000;
    while (this.running && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  async dispatchOne(): Promise<boolean> {
    if (this.running || this.stopping) return false;
    const record = this.store.claimOutbox();
    if (!record) return false;
    this.running = true;
    try {
      const send = this.send(record);
      let timeout: NodeJS.Timeout;
      const result = await Promise.race([
        send,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new FeishuApiError("飞书发送超时", { timeout: true })),
            this.options.timeoutMs ?? 30_000,
          );
        }),
      ]).finally(() => clearTimeout(timeout!));
      this.options.afterSend?.();
      if (this.stopping) return true;
      this.store.markSent(record.id, result || record.externalId || "");
      return true;
    } catch (error) {
      if (error instanceof InjectedOutboxFault) throw error;
      if (this.stopping) return true;
      const cause = error instanceof Error ? error : new Error(String(error));
      if (
        (error instanceof FeishuApiError && error.options.timeout) ||
        /timeout|timed out|ETIMEDOUT/i.test(cause.message)
      ) {
        this.store.markUnknown(record.id, cause.message);
        // 迟到的 Promise 只记录日志，不把 UNKNOWN 擅自改成 SENT，也不重放。
        void Promise.resolve(this.sendLateObservation(record)).catch(() => {});
      } else if (error instanceof FeishuApiError && error.options.retryable && record.attemptCount < 8) {
        this.store.markRetry(record.id, cause.message);
      } else {
        this.store.markFailed(record.id, cause.message);
      }
      return true;
    } finally {
      this.running = false;
    }
  }

  private async send(record: OutboxRecord): Promise<string> {
    const payload = record.payload;
    switch (record.kind) {
      case "digest.card":
        return this.api.sendCard(record.conversationId, this.digestCard(payload));
      case "group.accepted":
        return this.api.replyText(
          payload.replyToMessageId,
          `已受理，WorkItem ${payload.workItemId}。将先只读生成计划，批准后才执行。`,
        );
      case "workitem.accepted":
        return this.api.sendText(
          record.conversationId,
          `已生成 Trigger / WorkItem ${payload.workItemId}，不会跳过计划审批。`,
        );
      case "plan.pending":
        return this.api.sendCard(record.conversationId, this.planCard(payload));
      case "plan.resolved": {
        const row = this.store.db
          .prepare("SELECT message_id FROM feishu_cards WHERE work_item_id = ? ORDER BY updated_at DESC LIMIT 1")
          .get(payload.workItemId) as { message_id: string } | undefined;
        if (!row) return this.api.sendText(record.conversationId, `计划审批已结清：${payload.workItemId}`);
        await this.api.updateCard(
          row.message_id,
          card("Spcode 计划审批", "grey", [markdown(`已处理 ${payload.workItemId}\n${payload.status}`)]),
        );
        return row.message_id;
      }
      case "digest.resolved": {
        const row = this.store.db
          .prepare("SELECT message_id FROM feishu_cards WHERE digest_id = ? ORDER BY updated_at DESC LIMIT 1")
          .get(payload.digestId) as { message_id: string } | undefined;
        if (!row)
          return this.api.sendText(
            record.conversationId,
            `Issue 快照已${payload.resolution === "IGNORED" ? "忽略" : "处理"}`,
          );
        await this.api.updateCard(
          row.message_id,
          card("Spcode Issue 摘要", "grey", [
            markdown(`${payload.issue.title}\n\n当前快照已${payload.resolution === "IGNORED" ? "忽略" : "处理"}。`),
          ]),
        );
        return row.message_id;
      }
      case "workitem.completed":
        return this.api.sendText(
          record.conversationId,
          `WorkItem ${payload.workItemId} 已完成。\n本地 commit：${payload.commitSha}\n验证：${payload.tests ?? "见工作台"}\n不会自动 push 或 merge。`,
        );
      case "workitem.failed":
        return this.api.sendText(
          record.conversationId,
          `WorkItem ${payload.workItemId} 需要人工处理：${payload.error}`,
        );
      default:
        throw new FeishuApiError(`未知 Outbox 类型：${record.kind}`);
    }
  }

  private digestCard(payload: any): Record<string, unknown> {
    const issues = Array.isArray(payload.issues) ? payload.issues : [];
    if (issues.length === 0) {
      return card(`Spcode ${payload.repo} Issue 摘要`, "blue", [
        markdown("自上次成功游标以来没有新增或实质更新的 open Issue。"),
      ]);
    }
    const elements: Record<string, unknown>[] = [];
    for (const issue of issues) {
      elements.push(
        markdown(
          `**#${issue.number} ${issue.title}**\n作者：${issue.author} · ${issue.labels.join(", ") || "无标签"}\n${String(issue.body).slice(0, 500)}\n${issue.url}`,
        ),
      );
      elements.push({
        tag: "action",
        actions: [
          button("生成 Trigger", "primary", {
            action: "digest.trigger",
            digestId: payload.digestId,
            itemId: this.itemId(payload.digestId, issue.id),
            digestHash: payload.digestHash,
          }),
          button("忽略当前快照", "default", {
            action: "digest.ignore",
            digestId: payload.digestId,
            itemId: this.itemId(payload.digestId, issue.id),
            digestHash: payload.digestHash,
          }),
        ],
      });
    }
    return card(`Spcode ${payload.repo} Issue 摘要`, "blue", elements);
  }

  private planCard(payload: any): Record<string, unknown> {
    return card("Spcode 计划等待批准", "orange", [
      markdown(
        `**${payload.title}**\n仓库：${payload.repo}\nbaseSha：${payload.baseSha}\n范围：${payload.changeScope}\n验证：${payload.verification}\n风险：${payload.risk || "见完整计划"}\nplanHash：${payload.planHash}`,
      ),
      {
        tag: "action",
        actions: [
          button("批准当前计划", "primary", {
            action: "plan.approve",
            workItemId: payload.workItemId,
            planId: payload.planId,
            planHash: payload.planHash,
          }),
        ],
      },
    ]);
  }

  private itemId(digestId: string, externalId: string): string {
    const row = this.store.db
      .prepare("SELECT id FROM digest_items WHERE digest_id = ? AND external_id = ?")
      .get(digestId, externalId) as { id: string } | undefined;
    return row?.id ?? "";
  }

  private async sendLateObservation(record: OutboxRecord): Promise<void> {
    // Provider 对账钩子：没有 externalId 可证明时保持 UNKNOWN。真实 Provider 可凭资源标识查询。
    if (record.externalId)
      this.store.db.prepare("UPDATE outbox SET observed_status = 'NEEDS_REVIEW' WHERE id = ?").run(record.id);
  }
}
