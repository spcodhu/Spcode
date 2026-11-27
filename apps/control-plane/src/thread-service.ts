import { createHash, randomUUID } from "node:crypto";
import type { SqliteSuperAgentStore } from "./store-sqlite.js";

export interface ThreadEventInput {
  source: string;
  externalEventId: string;
  threadId: string;
  workItemId: string;
  kind: "ci.review" | "ci.status" | "context" | "human.requirement" | "stop";
  actorId: string;
  payload: Record<string, unknown>;
}

export class ThreadService {
  constructor(
    private readonly store: SqliteSuperAgentStore,
    private readonly publish: (sequence: number, workItemId?: string) => void = () => {},
  ) {}

  record(input: ThreadEventInput): { created: boolean; requiresStop: boolean } {
    if (
      this.store.db
        .prepare("SELECT 1 FROM thread_events WHERE source = ? AND external_event_id = ?")
        .get(input.source, input.externalEventId)
    ) {
      return { created: false, requiresStop: false };
    }
    this.store.db.exec("BEGIN IMMEDIATE");
    let eventId: number;
    try {
      const now = Date.now();
      this.store.db
        .prepare(
          "INSERT INTO thread_events(id, source, external_event_id, thread_id, work_item_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          `te_${randomUUID()}`,
          input.source,
          input.externalEventId,
          input.threadId,
          input.workItemId,
          JSON.stringify({ kind: input.kind, ...input.payload }),
          now,
        );
      const item = this.store.db
        .prepare("SELECT status, desired_state, current_plan_id, base_sha FROM work_items WHERE id = ?")
        .get(input.workItemId) as
        | { status: string; desired_state: string; current_plan_id: string | null; base_sha: string | null }
        | undefined;
      if (!item) throw new Error("Thread 对应 WorkItem 不存在");
      if (item.desired_state === "STOPPED" || item.status === "CANCELLED") {
        this.store.db.exec("COMMIT");
        return { created: true, requiresStop: false };
      }
      if (input.kind === "stop") {
        this.store.db
          .prepare("INSERT INTO mailbox(work_item_id, kind, payload_json, created_at) VALUES (?, 'stop', ?, ?)")
          .run(input.workItemId, JSON.stringify(input.payload), now);
      } else if (input.kind === "human.requirement") {
        const content = String(input.payload.content ?? input.payload.text ?? "").trim();
        if (!content) throw new Error("人的新需求内容为空");
        const previous = item.current_plan_id
          ? (this.store.db.prepare("SELECT * FROM plan_revisions WHERE id = ?").get(item.current_plan_id) as
              | Record<string, any>
              | undefined)
          : undefined;
        const revision =
          ((
            this.store.db
              .prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM plan_revisions WHERE work_item_id = ?")
              .get(input.workItemId) as { revision: number }
          ).revision ?? 0) + 1;
        const planId = `pl_${randomUUID()}`;
        const baseSha = item.base_sha ?? previous?.base_sha ?? "unknown";
        const planHash = createHash("sha256")
          .update(JSON.stringify({ planId, revision, content, baseSha, request: input.payload }))
          .digest("hex");
        this.store.db
          .prepare(
            "UPDATE plan_revisions SET status = 'SUPERSEDED' WHERE work_item_id = ? AND status IN ('PENDING', 'APPROVED')",
          )
          .run(input.workItemId);
        this.store.db
          .prepare(
            "INSERT INTO plan_revisions(id, work_item_id, revision, content, plan_hash, base_sha, verification_json, change_scope_json, publish_intent, effect_intent_json, risk, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)",
          )
          .run(
            planId,
            input.workItemId,
            revision,
            content,
            planHash,
            baseSha,
            previous?.verification_json ?? "[]",
            previous?.change_scope_json ?? "[]",
            previous?.publish_intent ?? 0,
            previous?.effect_intent_json ?? "[]",
            String(input.payload.risk ?? previous?.risk ?? ""),
            now,
          );
        this.store.db
          .prepare(
            "UPDATE work_items SET status = 'PLANNING', desired_state = 'ACTIVE', current_plan_id = ?, active_attempt_id = NULL, updated_at = ? WHERE id = ?",
          )
          .run(planId, now, input.workItemId);
        this.store.db
          .prepare(
            "INSERT INTO mailbox(work_item_id, kind, payload_json, created_at) VALUES (?, 'human.requirement', ?, ?)",
          )
          .run(input.workItemId, JSON.stringify(input.payload), now);
        this.store.db
          .prepare("INSERT INTO events(work_item_id, type, created_at) VALUES (?, 'plan.submit', ?)")
          .run(input.workItemId, now);
      } else {
        this.store.db
          .prepare("INSERT INTO mailbox(work_item_id, kind, payload_json, created_at) VALUES (?, 'context', ?, ?)")
          .run(input.workItemId, JSON.stringify({ kind: input.kind, ...input.payload }), now);
      }
      eventId = Number(
        this.store.db
          .prepare("INSERT INTO events(work_item_id, type, created_at) VALUES (?, ?, ?)")
          .run(input.workItemId, `thread.${input.kind}`, now).lastInsertRowid,
      );
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    this.publish(eventId, input.workItemId);
    return { created: true, requiresStop: input.kind === "stop" };
  }

  list(workItemId: string): Array<Record<string, unknown>> {
    return this.store.db
      .prepare(
        "SELECT id, source, external_event_id, thread_id, work_item_id, payload_json, created_at FROM thread_events WHERE work_item_id = ? ORDER BY created_at, id",
      )
      .all(workItemId) as unknown as Array<Record<string, unknown>>;
  }
}
