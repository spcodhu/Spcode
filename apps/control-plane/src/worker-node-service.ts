import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type {
  RecoveryBundle,
  WorkerAssignment,
  WorkerNodeCapabilities,
  WorkerNodeClientMessage,
} from "@spcode/shared/worker-node";
import { WORKER_NODE_PROTOCOL_VERSION } from "@spcode/shared/worker-node";
import type { SuperAgentEngine } from "@spcode/superagent";
import { WebSocket, WebSocketServer } from "ws";
import type { ArtifactRecord } from "./artifact-store.js";
import { tokensEqual } from "./auth.js";
import type { GitWorkspace } from "./git-workspace.js";
import type { RouterStore } from "./router-store.js";
import type { SqliteSuperAgentStore } from "./store-sqlite.js";
import type { WorkerStore } from "./worker-store.js";

function planList(content: string, headings: string[]): string[] {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    headings.some((heading) => new RegExp(`^##\\s+${heading}\\s*$`, "i").test(line.trim())),
  );
  if (start < 0) return [];
  const result: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) break;
    const value = line
      .replace(/^(?:[-*+] |\d+\.\s+)/, "")
      .replace(/^`|`$/g, "")
      .trim();
    if (value && !/^```/.test(value)) result.push(value);
  }
  return result;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export class WorkerNodeService {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  private readonly connections = new Map<string, WebSocket>();
  private timer: NodeJS.Timeout | null = null;
  private engine?: SuperAgentEngine;

  constructor(
    private readonly store: SqliteSuperAgentStore,
    private readonly workers: WorkerStore,
    private readonly router: RouterStore,
    private readonly enabled: () => boolean = () => true,
  ) {}

  start(): void {
    this.recoverStale();
    this.timer = setInterval(() => this.recoverStale(), 5000);
  }

  attachEngine(engine: SuperAgentEngine): void {
    this.engine = engine;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const socket of this.connections.values()) socket.close(1001, "control plane stopping");
    this.connections.clear();
    this.wss.close();
  }

  pair(
    name: string,
    protocolVersion: number,
    capabilities: WorkerNodeCapabilities,
  ): { nodeId: string; nodeToken: string } {
    if (protocolVersion !== WORKER_NODE_PROTOCOL_VERSION) throw new Error("不兼容 Worker 协议版本");
    if (!name.trim() || name.length > 100) throw new Error("节点名称无效");
    const nodeId = `wn_${randomUUID()}`;
    const nodeToken = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.store.db
      .prepare(
        "INSERT INTO worker_nodes(id, name, token_hash, protocol_version, capabilities_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)",
      )
      .run(nodeId, name, hash(nodeToken), protocolVersion, JSON.stringify(capabilities), now, now);
    return { nodeId, nodeToken };
  }

  revoke(nodeId: string): void {
    this.router.revokeNode(nodeId);
    this.connections.get(nodeId)?.close(4003, "node revoked");
    this.connections.delete(nodeId);
  }

  nodes(): Array<Record<string, unknown>> {
    return this.store.db
      .prepare(
        "SELECT id, name, protocol_version, capabilities_json, status, last_heartbeat_at, revoked_at, created_at, updated_at FROM worker_nodes ORDER BY created_at",
      )
      .all() as unknown as Array<Record<string, unknown>>;
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const nodeId = this.authenticate(request);
    const protocol = Number(request.headers["x-spcode-worker-protocol"] ?? 0);
    if (!nodeId || protocol !== WORKER_NODE_PROTOCOL_VERSION) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.connections.set(nodeId, ws);
      this.store.db
        .prepare("UPDATE worker_nodes SET status = 'ACTIVE', last_heartbeat_at = ?, updated_at = ? WHERE id = ?")
        .run(Date.now(), Date.now(), nodeId);
      ws.on("message", (data) => void this.accept(nodeId, data.toString()));
      ws.on("close", () => {
        if (this.connections.get(nodeId) === ws) this.connections.delete(nodeId);
      });
      ws.on("error", () => {});
      ws.send(
        JSON.stringify({
          type: "worker.hello",
          protocolVersion: WORKER_NODE_PROTOCOL_VERSION,
          nodeId,
          serverTime: Date.now(),
        }),
      );
    });
  }

  async handleArtifact(request: IncomingMessage, body: Buffer): Promise<ArtifactRecord> {
    const nodeId = this.authenticate(request);
    if (!nodeId) throw new Error("Worker 节点未认证");
    const attemptId = String(request.headers["x-spcode-attempt-id"] ?? "");
    const fence = Number(request.headers["x-spcode-fence"] ?? 0);
    if (!this.router.renew(attemptId, nodeId, fence)) throw new Error("stale fence：Artifact 上传被拒绝");
    const attempt = this.workers.getAttempt(attemptId);
    const declared = String(request.headers["x-spcode-sha256"] ?? "");
    if (body.byteLength === 0 || body.byteLength > 16 * 1024 * 1024 || hash(body) !== declared) {
      throw new Error("Artifact hash/size 校验失败");
    }
    const record = this.store.artifacts.put({
      workItemId: attempt.workItemId,
      kind: "worker-upload",
      content: body,
      mimeType: "application/octet-stream",
    });
    return record;
  }

  private authenticate(request: IncomingMessage): string | null {
    const authorization = request.headers.authorization ?? "";
    if (!authorization.startsWith("Bearer ")) return null;
    const [nodeId, token] = authorization.slice(7).split(":");
    if (!nodeId || !token) return null;
    const row = this.store.db
      .prepare("SELECT token_hash, status, revoked_at, protocol_version FROM worker_nodes WHERE id = ?")
      .get(nodeId) as
      | { token_hash: string; status: string; revoked_at: number | null; protocol_version: number }
      | undefined;
    if (row?.status !== "ACTIVE" || row.revoked_at !== null || row.protocol_version !== WORKER_NODE_PROTOCOL_VERSION)
      return null;
    return tokensEqual(hash(token), row.token_hash) ? nodeId : null;
  }

  private async accept(nodeId: string, raw: string): Promise<void> {
    if (!this.connections.has(nodeId)) return;
    let message: WorkerNodeClientMessage;
    try {
      message = JSON.parse(raw) as WorkerNodeClientMessage;
    } catch {
      return;
    }
    try {
      switch (message.type) {
        case "worker.capabilities":
          this.store.db
            .prepare("UPDATE worker_nodes SET capabilities_json = ?, updated_at = ? WHERE id = ?")
            .run(JSON.stringify(message.capabilities), Date.now(), nodeId);
          await this.dispatch(nodeId, message.capabilities.capacity);
          break;
        case "worker.heartbeat":
          this.store.db
            .prepare("UPDATE worker_nodes SET status = 'ACTIVE', last_heartbeat_at = ?, updated_at = ? WHERE id = ?")
            .run(Date.now(), Date.now(), nodeId);
          for (const lease of this.router
            .leases()
            .filter((lease) => lease.nodeId === nodeId && lease.status === "ACTIVE")) {
            this.router.renew(lease.id, nodeId, lease.fence);
          }
          break;
        case "worker.pull":
          await this.dispatch(nodeId, message.maxItems);
          break;
        case "worker.assignmentAck": {
          if (!this.router.renew(message.attemptId, nodeId, message.fence)) return;
          const attempt = this.workers.getAttempt(message.attemptId);
          const workspace: GitWorkspace = {
            workItemId: attempt.workItemId,
            repo: this.workers.getItem(attempt.workItemId).repo,
            ...message.workspace,
          };
          this.workers.attachWorker(attempt.id, attempt.fence, message.pid, workspace);
          break;
        }
        case "worker.event":
          if (this.router.renew(message.attemptId, nodeId, message.fence)) {
            if (message.eventType === "session.file") {
              const sessionFile = (message.payload as { sessionFile?: unknown }).sessionFile;
              if (typeof sessionFile === "string")
                this.workers.saveSessionFile(message.attemptId, message.fence, sessionFile);
            }
            this.workers.appendEvent(message.attemptId, message.fence, message.seq, message.eventType, message.payload);
          }
          break;
        case "worker.complete":
          await this.complete(nodeId, message);
          break;
        case "worker.fail":
          this.fail(nodeId, message);
          break;
      }
    } catch (error) {
      const connection = this.connections.get(nodeId);
      connection?.send(
        JSON.stringify({
          type: "worker.error",
          code: "WORKER_REJECTED",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private async dispatch(nodeId: string, maxItems: number): Promise<void> {
    if (!this.enabled()) return;
    const connection = this.connections.get(nodeId);
    if (!connection || connection.readyState !== WebSocket.OPEN) return;
    const activeForNode = this.router
      .leases()
      .filter((lease) => lease.nodeId === nodeId && lease.status === "ACTIVE").length;
    const capacity = Math.max(0, Math.min(maxItems, 4) - activeForNode);
    if (capacity <= 0) return;
    const items = this.workers.listDispatchable().slice(0, capacity);
    for (const item of items) {
      const role = item.status === "PLANNING" ? "plan" : "execute";
      let attempt: import("@spcode/shared/superagent").AttemptSnapshot;
      try {
        attempt = this.workers.startAttempt(item.id, role);
        this.router.assignAttempt(attempt.id, nodeId);
      } catch {
        continue;
      }
      const plan =
        role === "execute"
          ? (this.store.snapshot().plans.find((candidate) => candidate.id === item.currentPlanId) ?? null)
          : null;
      const assignment: WorkerAssignment = {
        workItem: item,
        plan,
        attempt,
        role,
        baseSha: plan?.baseSha ?? item.baseSha,
        ...(this.recoveryBundle(item.id) ? { recoveryBundle: this.recoveryBundle(item.id)! } : {}),
      };
      connection.send(JSON.stringify({ type: "worker.assignment", assignment }));
    }
  }

  private async complete(
    nodeId: string,
    message: Extract<WorkerNodeClientMessage, { type: "worker.complete" }>,
  ): Promise<void> {
    if (!this.router.renew(message.attemptId, nodeId, message.fence)) throw new Error("stale fence：完成回执被拒绝");
    const attempt = this.workers.getAttempt(message.attemptId);
    if (attempt.role === "plan") {
      if (!message.planContent || !this.engine) throw new Error("计划回执缺少 planContent 或执行引擎");
      const verification = planList(message.planContent, ["验证命令", "Verification", "Verification Commands"]);
      if (verification.length === 0) throw new Error("计划缺少验证命令");
      const item = this.workers.getItem(attempt.workItemId);
      if (!item.baseSha) throw new Error("计划缺少批准基线");
      this.engine.execute(
        {
          type: "plan.submit",
          workItemId: item.id,
          content: message.planContent,
          baseSha: item.baseSha,
          verification,
          changeScope: planList(message.planContent, ["拟改范围", "Change Scope", "Scope"]),
        },
        "local-device",
      );
      this.workers.finishAttempt(attempt.id, attempt.fence, "COMPLETED");
      this.router.finish(attempt.id, nodeId, message.fence);
      return;
    }
    if (message.report.status !== "ready") {
      this.workers.setStatus(
        attempt.id,
        attempt.fence,
        message.report.status === "failed" ? "FAILED" : "BLOCKED",
        message.report.summary,
      );
      this.workers.finishAttempt(attempt.id, attempt.fence, "FAILED");
      this.router.finish(attempt.id, nodeId, message.fence);
      return;
    }
    if (!message.commitSha || !message.diff) throw new Error("ready 回执缺少实际 commit/diff");
    this.workers.setStatus(attempt.id, attempt.fence, "VALIDATING");
    this.workers.setStatus(attempt.id, attempt.fence, "COMMITTING");
    this.workers.completeCommit(attempt.id, attempt.fence, message.commitSha, message.diff as any, message.report);
    if (message.diffArtifactId) this.attachArtifact(attempt.workItemId, message.diffArtifactId, "diff_artifact_id");
    if (message.logArtifactId)
      this.attachArtifact(attempt.workItemId, message.logArtifactId, "log_artifact_id", attempt.id);
    this.router.finish(attempt.id, nodeId, message.fence);
  }

  private fail(nodeId: string, message: Extract<WorkerNodeClientMessage, { type: "worker.fail" }>): void {
    if (!this.router.renew(message.attemptId, nodeId, message.fence)) return;
    const attempt = this.workers.getAttempt(message.attemptId);
    if (message.retry) {
      this.recoverAttempt(attempt.id);
      return;
    }
    this.workers.setStatus(attempt.id, attempt.fence, "FAILED", message.error);
    this.workers.finishAttempt(attempt.id, attempt.fence, "FAILED");
    this.router.finish(attempt.id, nodeId, message.fence);
  }

  recoverStale(): void {
    const now = Date.now();
    for (const lease of this.router.leases()) {
      if (lease.status !== "ACTIVE" || lease.expiresAt > now) continue;
      this.recoverAttempt(lease.id);
    }
  }

  private recoverAttempt(attemptId: string): void {
    const attempt = this.workers.getAttempt(attemptId);
    if (attempt.role === "plan") {
      this.workers.releasePlanningAfterCrash(attemptId);
      return;
    }
    this.sealRecovery(attemptId);
    this.workers.markExecutionRecovering(attemptId);
    const lease = this.router.leases().find((candidate) => candidate.id === attemptId);
    if (lease) this.router.finish(attemptId, lease.nodeId, lease.fence);
    this.workers.finishReconciliation(attemptId, {
      status: "clean-base",
      detail: "节点失联，已封存 RecoveryBundle，等待新节点对账",
    });
  }

  private sealRecovery(attemptId: string): void {
    const attempt = this.workers.getAttempt(attemptId);
    const item = this.workers.getItem(attempt.workItemId);
    const plan = item.currentPlanId
      ? this.store.snapshot().plans.find((candidate) => candidate.id === item.currentPlanId)
      : null;
    const payload = {
      worktreePath: attempt.worktreePath,
      branch: attempt.branch,
      baseSha: item.baseSha,
      sessionFile: item.workerSessionFile,
      planHash: plan?.planHash ?? null,
      report: attempt.report,
      diff: item.diff,
    };
    const bundleHash = hash(JSON.stringify(payload));
    this.store.db
      .prepare(
        "INSERT INTO recovery_bundles(id, work_item_id, attempt_id, bundle_hash, snapshot_version, fence, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(work_item_id, bundle_hash, fence) DO NOTHING",
      )
      .run(
        `rb_${randomUUID()}`,
        item.id,
        attemptId,
        bundleHash,
        this.store.snapshot().revision,
        attempt.fence,
        JSON.stringify(payload),
        Date.now(),
      );
  }

  private recoveryBundle(workItemId: string): RecoveryBundle | null {
    const row = this.store.db
      .prepare("SELECT * FROM recovery_bundles WHERE work_item_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(workItemId) as Record<string, any> | undefined;
    if (!row) return null;
    return {
      id: row.id,
      workItemId,
      attemptId: row.attempt_id,
      bundleHash: row.bundle_hash,
      snapshotVersion: row.snapshot_version,
      fence: row.fence,
      mode: "review",
      payload: JSON.parse(row.payload_json),
    };
  }

  private attachArtifact(
    workItemId: string,
    artifactId: string,
    column: "diff_artifact_id" | "log_artifact_id",
    attemptId?: string,
  ): void {
    const artifact = this.store.artifacts.get(artifactId);
    if (!artifact || artifact.workItemId !== workItemId) throw new Error("Artifact 与 WorkItem 不匹配");
    if (column === "diff_artifact_id")
      this.store.db.prepare("UPDATE work_items SET diff_artifact_id = ? WHERE id = ?").run(artifactId, workItemId);
    else if (attemptId)
      this.store.db.prepare("UPDATE attempts SET log_artifact_id = ? WHERE id = ?").run(artifactId, attemptId);
  }
}
