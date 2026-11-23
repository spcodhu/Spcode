import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SqliteSuperAgentStore } from "./store-sqlite.js";

export interface IssueSnapshot {
  id: string;
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  url: string;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
}

export interface DigestItemSnapshot extends IssueSnapshot {
  itemId: string;
  digestId: string;
  resolution: "APPROVED" | "IGNORED" | null;
  workItemId?: string;
}

export interface DigestSnapshot {
  id: string;
  repo: string;
  localDate: string;
  digestHash: string;
  status: string;
  items: DigestItemSnapshot[];
  createdAt: number;
}

export interface OutboxRecord {
  id: string;
  conversationId: string;
  kind: string;
  payload: any;
  status: string;
  externalId: string | null;
  attemptCount: number;
  nextRunAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parse<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

export function migrateSourceSchema(db: DatabaseSync): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version > 3) throw new Error(`控制面数据库版本 ${version} 高于当前程序支持的版本 3`);
  if (version >= 3) return;
  if (version !== 2) throw new Error("Source schema 需要从 v2 迁移");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [name, type] of [
      ["repo", "TEXT"],
      ["digest_hash", "TEXT"],
      ["item_count", "INTEGER NOT NULL DEFAULT 0"],
      ["error", "TEXT"],
      ["completed_at", "INTEGER"],
    ] as const) {
      db.exec(`ALTER TABLE digest_runs ADD COLUMN ${name} ${type}`);
    }
    for (const [name, type] of [
      ["input_hash", "TEXT"],
      ["resource", "TEXT"],
      ["observed_status", "TEXT"],
    ] as const) {
      db.exec(`ALTER TABLE outbox ADD COLUMN ${name} ${type}`);
    }
    db.exec(`
      CREATE TABLE repo_cursors (
        repo TEXT PRIMARY KEY,
        cursor TEXT,
        last_success_at INTEGER NOT NULL
      );
      CREATE TABLE issue_snapshots (
        repo TEXT NOT NULL,
        external_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY(repo, external_id, content_hash)
      );
      CREATE TABLE thread_events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        external_event_id TEXT NOT NULL,
        thread_id TEXT,
        work_item_id TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(source, external_event_id)
      );
      CREATE TABLE subscriptions (
        thread_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(thread_id, work_item_id)
      );
      CREATE TABLE feishu_cards (
        message_id TEXT PRIMARY KEY,
        outbox_id TEXT NOT NULL,
        digest_id TEXT,
        work_item_id TEXT,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      PRAGMA user_version = 3;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export class SourceStore {
  constructor(
    readonly db: DatabaseSync,
    private readonly base: SqliteSuperAgentStore,
    private readonly publish: (sequence: number, workItemId?: string) => void,
  ) {}

  cursor(repo: string): { cursor: string | null; lastSuccessAt: number } {
    const row = this.db.prepare("SELECT * FROM repo_cursors WHERE repo = ?").get(repo) as
      | { cursor: string | null; last_success_at: number }
      | undefined;
    return { cursor: row?.cursor ?? null, lastSuccessAt: row?.last_success_at ?? 0 };
  }

  recordDigest(input: {
    scheduleId: string;
    localDate: string;
    configVersion: number;
    repo: string;
    issues: IssueSnapshot[];
    cursor: string;
    chatId: string;
  }): { digestId: string; created: boolean } {
    const existing = this.db
      .prepare("SELECT id FROM digest_runs WHERE schedule_id = ? AND local_date = ? AND config_version = ?")
      .get(input.scheduleId, input.localDate, input.configVersion) as { id: string } | undefined;
    if (existing) return { digestId: existing.id, created: false };
    const digestId = `dg_${randomUUID()}`;
    const digestHash = hash({ repo: input.repo, localDate: input.localDate, issues: input.issues });
    this.db.exec("BEGIN IMMEDIATE");
    let eventId: number;
    try {
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO digest_runs(id, schedule_id, local_date, config_version, status, created_at, repo, digest_hash, item_count, completed_at)
           VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)`,
        )
        .run(
          digestId,
          input.scheduleId,
          input.localDate,
          input.configVersion,
          now,
          input.repo,
          digestHash,
          input.issues.length,
          now,
        );
      for (const issue of input.issues) {
        this.db
          .prepare(
            "INSERT INTO digest_items(id, digest_id, external_id, content_hash, snapshot_json) VALUES (?, ?, ?, ?, ?)",
          )
          .run(`di_${randomUUID()}`, digestId, issue.id, issue.contentHash, JSON.stringify(issue));
        this.db
          .prepare(
            `INSERT INTO issue_snapshots(repo, external_id, content_hash, snapshot_json, last_seen_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(repo, external_id, content_hash) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
          )
          .run(input.repo, issue.id, issue.contentHash, JSON.stringify(issue), now);
      }
      this.insertOutbox({
        conversationId: input.chatId,
        kind: "digest.card",
        payload: { digestId, digestHash, repo: input.repo, localDate: input.localDate, issues: input.issues },
      });
      this.db
        .prepare(
          `INSERT INTO repo_cursors(repo, cursor, last_success_at) VALUES (?, ?, ?)
           ON CONFLICT(repo) DO UPDATE SET cursor = excluded.cursor, last_success_at = excluded.last_success_at`,
        )
        .run(input.repo, input.cursor, now);
      eventId = Number(
        this.db
          .prepare("INSERT INTO events(work_item_id, type, created_at) VALUES (NULL, 'digest.recorded', ?)")
          .run(now).lastInsertRowid,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.publish(eventId);
    return { digestId, created: true };
  }

  listDigests(limit = 50): DigestSnapshot[] {
    const runs = this.db
      .prepare("SELECT * FROM digest_runs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as Array<{
      id: string;
      repo: string;
      local_date: string;
      digest_hash: string;
      status: string;
      created_at: number;
    }>;
    return runs.map((run) => ({
      id: run.id,
      repo: run.repo,
      localDate: run.local_date,
      digestHash: run.digest_hash,
      status: run.status,
      createdAt: run.created_at,
      items: this.db
        .prepare("SELECT * FROM digest_items WHERE digest_id = ? ORDER BY external_id")
        .all(run.id)
        .map((raw) => {
          const row = raw as {
            id: string;
            digest_id: string;
            snapshot_json: string;
            resolution: "APPROVED" | "IGNORED" | null;
          };
          const issue = parse<IssueSnapshot>(row.snapshot_json);
          const trigger = this.db
            .prepare("SELECT id FROM triggers WHERE source = 'github-issue' AND external_id = ?")
            .get(row.id) as { id: string } | undefined;
          const workItem = trigger
            ? (this.db.prepare("SELECT id FROM work_items WHERE trigger_id = ?").get(trigger.id) as
                | { id: string }
                | undefined)
            : undefined;
          return {
            ...issue,
            itemId: row.id,
            digestId: row.digest_id,
            resolution: row.resolution,
            ...(workItem ? { workItemId: workItem.id } : {}),
          };
        }),
    }));
  }

  resolveDigestItem(input: {
    digestId: string;
    itemId: string;
    digestHash: string;
    action: "approve" | "ignore";
    actorId: string;
    chatId: string;
  }): { workItemId?: string; created: boolean } {
    const row = this.db
      .prepare(
        `SELECT i.*, r.repo, r.digest_hash FROM digest_items i JOIN digest_runs r ON r.id = i.digest_id
         WHERE i.id = ? AND i.digest_id = ?`,
      )
      .get(input.itemId, input.digestId) as
      | {
          id: string;
          external_id: string;
          content_hash: string;
          snapshot_json: string;
          resolution: string | null;
          repo: string;
          digest_hash: string;
        }
      | undefined;
    if (!row || row.digest_hash !== input.digestHash) throw new Error("摘要卡已过期或 digestHash 不匹配");
    const issue = parse<IssueSnapshot>(row.snapshot_json);
    if (row.resolution === "IGNORED") {
      if (input.action === "ignore") return { created: false };
      throw new Error("当前 Issue 快照已忽略，实质更新后才能重新生成 Trigger");
    }
    if (row.resolution === "APPROVED") {
      const existing = this.listDigests()
        .flatMap((digest) => digest.items)
        .find((item) => item.itemId === input.itemId);
      return { ...(existing?.workItemId ? { workItemId: existing.workItemId } : {}), created: false };
    }
    if (input.action === "ignore") {
      this.db.exec("BEGIN IMMEDIATE");
      let eventId: number;
      try {
        this.db.prepare("UPDATE digest_items SET resolution = 'IGNORED' WHERE id = ?").run(input.itemId);
        this.insertOutbox({
          conversationId: input.chatId,
          kind: "digest.resolved",
          payload: { digestId: input.digestId, itemId: input.itemId, resolution: "IGNORED", issue },
        });
        eventId = Number(
          this.db
            .prepare("INSERT INTO events(work_item_id, type, created_at) VALUES (NULL, 'digest.ignored', ?)")
            .run(Date.now()).lastInsertRowid,
        );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      this.publish(eventId);
      return { created: true };
    }
    const result = this.base.createSourceWorkItem(
      {
        source: "github-issue",
        externalEventId: `digest:${input.digestId}:${input.itemId}:${input.digestHash}`,
        triggerExternalId: input.itemId,
        actorId: input.actorId,
        containerId: input.chatId,
        payloadHash: row.content_hash,
        payload: issue,
        repo: row.repo,
        title: `Issue #${issue.number} ${issue.title}`,
        request: `${issue.title}\n\n${issue.body}\n\n来源：${issue.url}`,
        threadExternalId: input.digestId,
      },
      (workItemId) => {
        this.db.prepare("UPDATE digest_items SET resolution = 'APPROVED' WHERE id = ?").run(input.itemId);
        this.insertOutbox({
          conversationId: input.chatId,
          kind: "workitem.accepted",
          payload: { workItemId, digestId: input.digestId, itemId: input.itemId, issue },
        });
      },
    );
    this.publish(result.eventId, result.workItemId);
    return { workItemId: result.workItemId, created: result.created };
  }

  enqueueGroupAcceptance(input: {
    eventId: string;
    messageId: string;
    chatId: string;
    operatorId: string;
    text: string;
    repo: string;
    rootId?: string;
    threadId?: string;
    mentions: unknown[];
  }): { workItemId: string; created: boolean } {
    const payloadHash = hash({ eventId: input.eventId, text: input.text, repo: input.repo });
    const result = this.base.createSourceWorkItem(
      {
        source: "feishu-group",
        externalEventId: input.eventId,
        triggerExternalId: input.eventId,
        actorId: input.operatorId,
        containerId: input.chatId,
        payloadHash,
        payload: input,
        repo: input.repo,
        title: input.text.trim().slice(0, 100),
        request: input.text,
        threadExternalId: input.rootId ?? input.threadId ?? input.messageId,
      },
      (workItemId) => {
        this.insertOutbox({
          conversationId: input.chatId,
          kind: "group.accepted",
          payload: { workItemId, replyToMessageId: input.messageId, text: input.text },
        });
      },
    );
    this.publish(result.eventId, result.workItemId);
    return { workItemId: result.workItemId, created: result.created };
  }

  /** 事件日志是恢复依据；eventId 幂等投影，覆盖落库后/发卡前崩溃。 */
  projectNotifications(): void {
    const events = this.db
      .prepare(
        `SELECT * FROM events WHERE work_item_id IS NOT NULL
          AND type IN ('plan.submit', 'plan.approve', 'workitem.completed', 'workitem.status') ORDER BY id LIMIT 500`,
      )
      .all() as unknown as Array<{ id: number; work_item_id: string; type: string }>;
    for (const event of events) {
      const outboxId = `nt_${event.id}`;
      if (this.db.prepare("SELECT 1 FROM outbox WHERE id = ?").get(outboxId)) continue;
      const item = this.db
        .prepare(
          `SELECT w.*, se.container_id FROM work_items w JOIN triggers t ON t.id = w.trigger_id
           JOIN source_events se ON se.id = t.source_event_id WHERE w.id = ?`,
        )
        .get(event.work_item_id) as Record<string, any> | undefined;
      if (!item?.container_id) continue;
      let kind = "";
      let payload: Record<string, unknown> = { workItemId: item.id };
      if (event.type === "plan.submit") {
        const plan = this.db
          .prepare("SELECT * FROM plan_revisions WHERE id = ? AND status = 'PENDING'")
          .get(item.current_plan_id) as Record<string, any> | undefined;
        if (!plan) continue;
        kind = "plan.pending";
        payload = {
          ...payload,
          planId: plan.id,
          planHash: plan.plan_hash,
          title: item.title,
          repo: item.repo,
          baseSha: plan.base_sha,
          changeScope: plan.change_scope_json,
          verification: plan.verification_json,
          risk: plan.risk,
        };
      } else if (event.type === "plan.approve") {
        kind = "plan.resolved";
        payload = { ...payload, status: "APPROVED" };
      } else if (event.type === "workitem.completed") {
        kind = "workitem.completed";
        const report = item.report_json ? parse<{ tests?: unknown[] }>(item.report_json) : {};
        payload = {
          ...payload,
          commitSha: item.commit_sha,
          tests: report.tests?.map((test) => String(test)).join(", "),
        };
      } else if (["FAILED", "BLOCKED", "AWAITING_RECONCILIATION"].includes(item.status)) {
        kind = "workitem.failed";
        payload = { ...payload, error: item.last_error ?? item.status };
      } else {
        continue;
      }
      this.insertOutbox({ id: outboxId, conversationId: item.container_id, kind, payload });
    }
  }

  insertOutbox(input: { id?: string; conversationId: string; kind: string; payload: unknown }): string {
    const id = input.id ?? `ob_${randomUUID()}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO outbox(id, conversation_id, kind, payload_json, status, attempt_count, next_run_at, created_at, updated_at, input_hash, resource)
         VALUES (?, ?, ?, ?, 'PENDING', 0, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        input.conversationId,
        input.kind,
        JSON.stringify(input.payload),
        now,
        now,
        now,
        hash(input.payload),
        input.conversationId,
      );
    return id;
  }

  recoverSending(): void {
    this.db
      .prepare(
        "UPDATE outbox SET status = 'UNKNOWN', observed_status = 'UNKNOWN', last_error = '发送前状态未结清，需要外部对账', updated_at = ? WHERE status = 'SENDING'",
      )
      .run(Date.now());
  }

  claimOutbox(now = Date.now()): OutboxRecord | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM outbox WHERE status IN ('PENDING', 'RETRY') AND next_run_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM outbox earlier WHERE earlier.conversation_id = outbox.conversation_id
               AND earlier.status IN ('PENDING', 'RETRY', 'SENDING') AND earlier.created_at < outbox.created_at
           ) ORDER BY created_at LIMIT 1`,
        )
        .get(now) as Record<string, any> | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db
        .prepare("UPDATE outbox SET status = 'SENDING', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?")
        .run(now, row.id);
      this.db.exec("COMMIT");
      return this.outbox(row.id)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  outbox(id: string): OutboxRecord | null {
    const row = this.db.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as Record<string, any> | undefined;
    return row ? this.mapOutbox(row) : null;
  }

  listOutbox(limit = 200): OutboxRecord[] {
    return (
      this.db.prepare("SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as Array<
        Record<string, any>
      >
    ).map((row) => this.mapOutbox(row));
  }

  markSent(id: string, externalId: string): void {
    const record = this.outbox(id);
    if (!record) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      this.db
        .prepare(
          "UPDATE outbox SET status = 'SENT', observed_status = 'SENT', external_id = ?, last_error = NULL, updated_at = ? WHERE id = ?",
        )
        .run(externalId, now, id);
      if (record.kind === "digest.card") {
        this.db
          .prepare(
            "INSERT INTO feishu_cards(message_id, outbox_id, digest_id, status, updated_at) VALUES (?, ?, ?, 'SENT', ?) ON CONFLICT(message_id) DO UPDATE SET status = 'SENT', updated_at = excluded.updated_at",
          )
          .run(externalId, id, record.payload.digestId, now);
      } else if (record.kind === "plan.pending") {
        this.db
          .prepare(
            "INSERT INTO feishu_cards(message_id, outbox_id, work_item_id, status, updated_at) VALUES (?, ?, ?, 'SENT', ?) ON CONFLICT(message_id) DO UPDATE SET status = 'SENT', updated_at = excluded.updated_at",
          )
          .run(externalId, id, record.payload.workItemId, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markRetry(id: string, error: string, now = Date.now()): void {
    const record = this.outbox(id);
    const delay = Math.min(15 * 60_000, 1000 * 2 ** Math.min(record?.attemptCount ?? 1, 8));
    this.db
      .prepare("UPDATE outbox SET status = 'RETRY', next_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(now + delay, error, now, id);
  }

  markFailed(id: string, error: string): void {
    this.db
      .prepare("UPDATE outbox SET status = 'FAILED', last_error = ?, updated_at = ? WHERE id = ?")
      .run(error, Date.now(), id);
  }

  markUnknown(id: string, error: string): void {
    this.db
      .prepare(
        "UPDATE outbox SET status = 'UNKNOWN', observed_status = 'UNKNOWN', last_error = ?, updated_at = ? WHERE id = ?",
      )
      .run(error, Date.now(), id);
  }

  reconcileOutbox(id: string, outcome: "SENT" | "FAILED", externalId?: string): void {
    const record = this.outbox(id);
    if (record?.status !== "UNKNOWN") throw new Error("只有 UNKNOWN Outbox 可以人工对账");
    if (outcome === "SENT") {
      if (!externalId?.trim()) throw new Error("确认已送达必须提供外部 messageId 证据");
      this.markSent(id, externalId.trim());
    } else {
      this.db
        .prepare(
          "UPDATE outbox SET status = 'FAILED', observed_status = 'CONFIRMED_NOT_SENT', last_error = '人工确认未发送', updated_at = ? WHERE id = ?",
        )
        .run(Date.now(), id);
    }
  }

  digestConversation(digestId: string): string {
    const row = this.db
      .prepare("SELECT payload_json FROM outbox WHERE kind = 'digest.card' ORDER BY created_at DESC")
      .all() as unknown as Array<{
      payload_json: string;
    }>;
    for (const candidate of row) {
      const payload = parse<{ digestId?: string }>(candidate.payload_json);
      if (payload.digestId === digestId) {
        const record = this.db
          .prepare("SELECT conversation_id FROM outbox WHERE payload_json = ?")
          .get(candidate.payload_json) as { conversation_id: string } | undefined;
        if (record) return record.conversation_id;
      }
    }
    throw new Error("摘要没有目标群，无法从该入口处理");
  }

  card(messageId: string): { digestId: string | null; workItemId: string | null; outboxId: string } | null {
    const row = this.db.prepare("SELECT * FROM feishu_cards WHERE message_id = ?").get(messageId) as
      | { digest_id: string | null; work_item_id: string | null; outbox_id: string }
      | undefined;
    return row ? { digestId: row.digest_id, workItemId: row.work_item_id, outboxId: row.outbox_id } : null;
  }

  private mapOutbox(row: Record<string, any>): OutboxRecord {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      kind: row.kind,
      payload: parse(row.payload_json),
      status: row.status,
      externalId: row.external_id,
      attemptCount: row.attempt_count,
      nextRunAt: row.next_run_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
