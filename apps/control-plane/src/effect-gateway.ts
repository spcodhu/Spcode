import { createHash, randomUUID } from "node:crypto";
import type { EffectRecord, EffectRequestInput, EffectResult, EffectType } from "@spcode/shared/effect";
import { effectInputHash } from "@spcode/shared/effect";
import type { SqliteSuperAgentStore } from "./store-sqlite.js";
import type { WorkerStore } from "./worker-store.js";

const PUBLISH_TYPES = new Set<EffectType>(["git.push", "git.pr"]);

export class EffectGateway {
  constructor(
    private readonly store: SqliteSuperAgentStore,
    private readonly workers: WorkerStore,
    private readonly publish: (sequence: number, workItemId?: string) => void = () => {},
  ) {}

  request(input: EffectRequestInput, actorId: string): EffectRecord {
    const item = this.workers.getItem(input.workItemId);
    const plan = this.store.snapshot().plans.find((candidate) => candidate.id === item.currentPlanId);
    if (plan?.status !== "APPROVED" || plan.planHash !== input.planHash || plan.revision !== input.expectedRevision) {
      throw new Error("计划哈希或 expectedRevision 已过期");
    }
    if (PUBLISH_TYPES.has(input.type) && !plan.publishIntent) throw new Error("计划没有 publishIntent");
    if (!PUBLISH_TYPES.has(input.type) && !plan.effectIntent.includes(input.type) && !plan.effectIntent.includes("*")) {
      throw new Error("计划未声明该 Effect 范围");
    }
    if (!actorId.trim()) throw new Error("Effect 操作者不能为空");
    const inputHash = createHash("sha256").update(effectInputHash(input)).digest("hex");
    return this.transaction(item.id, "effect.request", () => {
      const existing = this.store.db
        .prepare("SELECT id FROM effect_requests WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as { id: string } | undefined;
      if (existing) {
        const request = this.store.db
          .prepare("SELECT input_hash FROM effect_requests WHERE id = ?")
          .get(existing.id) as { input_hash: string };
        if (request.input_hash !== inputHash) throw new Error("相同 idempotencyKey 对应不同输入");
        return this.record(
          (this.store.db.prepare("SELECT id FROM effects WHERE request_id = ?").get(existing.id) as { id: string }).id,
        );
      }
      const requestId = `er_${randomUUID()}`;
      const effectId = `ef_${randomUUID()}`;
      const now = Date.now();
      this.store.db
        .prepare(
          "INSERT INTO effect_requests(id, work_item_id, type, resource, input_json, input_hash, idempotency_key, expected_revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          requestId,
          item.id,
          input.type,
          input.resource,
          JSON.stringify(input.input),
          inputHash,
          input.idempotencyKey,
          input.expectedRevision,
          now,
        );
      this.store.db
        .prepare(
          "INSERT INTO effects(id, request_id, status, fence, next_run_at, created_at, updated_at) VALUES (?, ?, 'PENDING_APPROVAL', 0, ?, ?, ?)",
        )
        .run(effectId, requestId, now, now, now);
      this.store.db
        .prepare(
          "INSERT INTO outbox(id, conversation_id, kind, payload_json, status, next_run_at, created_at, updated_at, input_hash, resource) VALUES (?, ?, 'effect.execute', ?, 'PENDING', ?, ?, ?, ?, ?)",
        )
        .run(`ob_${randomUUID()}`, item.id, JSON.stringify({ effectId }), now, now, now, inputHash, input.resource);
      this.recordApproval(effectId, inputHash, "EFFECT_REQUEST", actorId, now);
      return this.record(effectId);
    });
  }

  approve(effectId: string, expectedInputHash: string, actorId: string): EffectRecord {
    const record = this.record(effectId);
    if (record.status !== "PENDING_APPROVAL") return record;
    const request = this.store.db
      .prepare("SELECT input_hash, work_item_id FROM effect_requests WHERE id = ?")
      .get(record.requestId) as { input_hash: string; work_item_id: string };
    if (request.input_hash !== expectedInputHash) throw new Error("Effect 批准输入哈希不匹配");
    this.transaction(request.work_item_id, "effect.approve", () => {
      const now = Date.now();
      this.recordApproval(effectId, expectedInputHash, "EFFECT_EXECUTE", actorId, now);
      this.store.db
        .prepare("UPDATE effects SET status = 'PENDING', updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'")
        .run(now, effectId);
      return this.record(effectId);
    });
    return this.record(effectId);
  }

  claim(executorId: string): EffectRecord | null {
    const row = this.store.db
      .prepare(
        "SELECT id, fence FROM effects WHERE status IN ('PENDING', 'RETRY') AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY created_at LIMIT 1",
      )
      .get(Date.now()) as { id: string; fence: number } | undefined;
    if (!row) return null;
    this.db().exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      const fence = row.fence + 1;
      const updated = this.store.db
        .prepare(
          "UPDATE effects SET status = 'RUNNING', fence = ?, updated_at = ? WHERE id = ? AND fence = ? AND status IN ('PENDING', 'RETRY')",
        )
        .run(fence, now, row.id, row.fence);
      if (updated.changes !== 1) {
        this.db().exec("ROLLBACK");
        return null;
      }
      this.store.db
        .prepare(
          "INSERT INTO effect_leases(id, effect_id, executor_id, fence, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?)",
        )
        .run(`el_${randomUUID()}`, row.id, executorId, fence, now + 120_000, now, now);
      this.db().exec("COMMIT");
      return this.record(row.id);
    } catch (error) {
      this.db().exec("ROLLBACK");
      throw error;
    }
  }

  complete(effectId: string, executorId: string, fence: number, result: EffectResult): void {
    this.db().exec("BEGIN IMMEDIATE");
    try {
      const lease = this.store.db
        .prepare(
          "SELECT id FROM effect_leases WHERE effect_id = ? AND executor_id = ? AND fence = ? AND status = 'ACTIVE'",
        )
        .get(effectId, executorId, fence);
      if (!lease) throw new Error("stale fence：Effect 回执被拒绝");
      const now = Date.now();
      this.store.db
        .prepare(
          "UPDATE effects SET status = ?, external_id = ?, result_json = ?, last_error = ?, updated_at = ? WHERE id = ? AND fence = ? AND status = 'RUNNING'",
        )
        .run(
          result.status,
          result.externalId ?? null,
          JSON.stringify(result),
          result.status === "FAILED" ? JSON.stringify(result.evidence) : null,
          now,
          effectId,
          fence,
        );
      this.store.db
        .prepare(
          "UPDATE effect_leases SET status = 'FINISHED', updated_at = ? WHERE effect_id = ? AND executor_id = ? AND fence = ?",
        )
        .run(now, effectId, executorId, fence);
      this.db().exec("COMMIT");
    } catch (error) {
      this.db().exec("ROLLBACK");
      throw error;
    }
  }

  recoverStale(): void {
    this.store.db
      .prepare(
        "UPDATE effects SET status = 'UNKNOWN', last_error = 'Executor 失联，结果未知', updated_at = ? WHERE status = 'RUNNING' AND id IN (SELECT effect_id FROM effect_leases WHERE status = 'ACTIVE' AND expires_at < ?)",
      )
      .run(Date.now(), Date.now());
    this.store.db
      .prepare("UPDATE effect_leases SET status = 'STALE', updated_at = ? WHERE status = 'ACTIVE' AND expires_at < ?")
      .run(Date.now(), Date.now());
  }

  reconcile(effectId: string, result: EffectResult): EffectRecord {
    const record = this.record(effectId);
    if (record.status !== "UNKNOWN") throw new Error("只有 UNKNOWN Effect 可以对账");
    this.store.db
      .prepare(
        "UPDATE effects SET status = ?, external_id = ?, result_json = ?, updated_at = ? WHERE id = ? AND status = 'UNKNOWN'",
      )
      .run(result.status, result.externalId ?? null, JSON.stringify(result), Date.now(), effectId);
    return this.record(effectId);
  }

  retry(effectId: string): EffectRecord {
    const record = this.record(effectId);
    if (record.status !== "FAILED") throw new Error("只有 FAILED Effect 可以人工重试，UNKNOWN 必须先对账");
    this.store.db
      .prepare("UPDATE effects SET status = 'RETRY', next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(Date.now(), Date.now(), effectId);
    return this.record(effectId);
  }

  payload(effectId: string): EffectRequestInput & { effectId: string; fence: number } {
    const row = this.store.db
      .prepare(
        `SELECT r.*, e.fence, w.current_plan_id FROM effect_requests r JOIN effects e ON e.request_id = r.id
         JOIN work_items w ON w.id = r.work_item_id WHERE e.id = ?`,
      )
      .get(effectId) as Record<string, any> | undefined;
    if (!row) throw new Error("Effect 请求不存在");
    const plan = this.store.snapshot().plans.find((candidate) => candidate.id === row.current_plan_id);
    if (!plan) throw new Error("Effect 对应计划不存在");
    if (plan.revision !== row.expected_revision) throw new Error("Effect expectedRevision 已过期");
    return {
      effectId,
      fence: row.fence,
      workItemId: row.work_item_id,
      planHash: plan.planHash,
      expectedRevision: row.expected_revision,
      type: row.type,
      resource: row.resource,
      input: JSON.parse(row.input_json),
      idempotencyKey: row.idempotency_key,
    };
  }

  record(effectId: string): EffectRecord {
    const row = this.store.db
      .prepare(
        "SELECT e.*, r.work_item_id, r.type, r.resource FROM effects e JOIN effect_requests r ON r.id = e.request_id WHERE e.id = ?",
      )
      .get(effectId) as Record<string, any> | undefined;
    if (!row) throw new Error("Effect 不存在");
    return {
      id: row.id,
      requestId: row.request_id,
      workItemId: row.work_item_id,
      type: row.type,
      resource: row.resource,
      status: row.status,
      fence: row.fence,
      externalId: row.external_id,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): EffectRecord[] {
    return (
      this.store.db.prepare("SELECT id FROM effects ORDER BY created_at DESC LIMIT 200").all() as unknown as Array<{
        id: string;
      }>
    ).map((row) => this.record(row.id));
  }

  private recordApproval(subjectId: string, subjectHash: string, kind: string, actorId: string, now: number): void {
    this.store.db
      .prepare(
        "INSERT INTO approvals(id, subject_id, subject_hash, kind, actor_id, policy_version, decision, created_at) VALUES (?, ?, ?, ?, ?, 1, 'APPROVED', ?)",
      )
      .run(`ap_${randomUUID()}`, subjectId, subjectHash, kind, actorId, now);
  }

  private db(): SqliteSuperAgentStore["db"] {
    return this.store.db;
  }

  private transaction<T>(workItemId: string, action: string, run: () => T): T {
    this.store.db.exec("BEGIN IMMEDIATE");
    let eventId: number;
    let result: T;
    try {
      result = run();
      eventId = Number(
        this.store.db
          .prepare("INSERT INTO events(work_item_id, type, created_at) VALUES (?, ?, ?)")
          .run(workItemId, action, Date.now()).lastInsertRowid,
      );
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    this.publish(eventId, workItemId);
    return result;
  }
}
