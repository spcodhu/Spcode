import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { GitWorkspaceManager } from "@spcode/control-plane/git-workspace";
import { verifyAndCommitWorkspace } from "@spcode/control-plane/worker-execution";
import { createDefaultWorkerRunner, type WorkerHandle } from "@spcode/control-plane/worker-runtime";
import type { ManagedWorkItem } from "@spcode/control-plane/worker-store";
import { readJsonFile, writeJsonFileAtomic } from "@spcode/shared/node";
import type { WorkerWorkReport } from "@spcode/shared/superagent";
import type { WorkerAssignment, WorkerNodeCapabilities, WorkerNodeServerMessage } from "@spcode/shared/worker-node";
import { WORKER_NODE_PROTOCOL_VERSION } from "@spcode/shared/worker-node";
import WebSocket from "ws";

export interface WorkerNodeOptions {
  controlUrl: string;
  name: string;
  dataDir: string;
  pairToken?: string;
  nodeId?: string;
  nodeToken?: string;
  capacity?: number;
  repoSource?: (repo: string) => string;
  pollMs?: number;
}

interface Credentials {
  nodeId: string;
  nodeToken: string;
  controlUrl: string;
}

function validateCredentials(value: unknown): Credentials | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<Credentials>;
  return typeof input.nodeId === "string" && typeof input.nodeToken === "string" && typeof input.controlUrl === "string"
    ? { nodeId: input.nodeId, nodeToken: input.nodeToken, controlUrl: input.controlUrl }
    : null;
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export class WorkerNodeApp {
  private readonly git: GitWorkspaceManager;
  private readonly runner;
  private socket: WebSocket | null = null;
  private readonly handles = new Map<string, WorkerHandle>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pullTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private credentials: Credentials | null = null;

  constructor(private readonly options: WorkerNodeOptions) {
    this.git = new GitWorkspaceManager(options.dataDir, options.repoSource ?? ((repo) => repo));
    this.runner = createDefaultWorkerRunner(options.dataDir, options.dataDir);
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.ensurePaired();
    await this.connect();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), 5000);
    this.pullTimer = setInterval(() => this.pull(), this.options.pollMs ?? 250);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of [this.heartbeatTimer, this.pullTimer, this.reconnectTimer]) if (timer) clearInterval(timer);
    this.heartbeatTimer = null;
    this.pullTimer = null;
    this.reconnectTimer = null;
    for (const handle of this.handles.values()) await handle.stop().catch(() => {});
    this.handles.clear();
    this.socket?.close(1000, "worker stopping");
    this.socket = null;
  }

  /** 故障注入专用：只断网络，保留本地 Worker 进程以模拟失联。 */
  disconnect(): void {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pullTimer) clearInterval(this.pullTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.pullTimer = null;
    this.socket?.close(4000, "simulated network loss");
    this.socket = null;
  }

  private async ensurePaired(): Promise<void> {
    if (this.options.nodeId && this.options.nodeToken) {
      this.credentials = {
        nodeId: this.options.nodeId,
        nodeToken: this.options.nodeToken,
        controlUrl: this.options.controlUrl,
      };
      return;
    }
    const saved = readJsonFile(join(this.options.dataDir, "node.json"), validateCredentials);
    if (saved) {
      this.credentials = saved;
      return;
    }
    if (!this.options.pairToken) throw new Error("首次启动需要 SPCODE_WORKER_PAIR_TOKEN");
    const response = await fetch(new URL("/api/v1/worker-nodes/pair", this.options.controlUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.pairToken}`,
        "X-Spcode-Control-Client": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: this.options.name,
        protocolVersion: WORKER_NODE_PROTOCOL_VERSION,
        capabilities: this.capabilities(),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Worker 配对失败：${response.status} ${await response.text()}`);
    const paired = (await response.json()) as Credentials;
    this.credentials = { ...paired, controlUrl: this.options.controlUrl };
    writeJsonFileAtomic(join(this.options.dataDir, "node.json"), this.credentials, { mode: 0o600 });
  }

  private async connect(): Promise<void> {
    if (!this.credentials) throw new Error("Worker 尚未配对");
    const base = new URL(this.credentials.controlUrl);
    const protocol = base.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${base.host}/api/v1/worker-node`, {
      headers: {
        Authorization: `Bearer ${this.credentials.nodeId}:${this.credentials.nodeToken}`,
        "X-Spcode-Worker-Protocol": String(WORKER_NODE_PROTOCOL_VERSION),
      },
      maxPayload: 2 * 1024 * 1024,
    });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Worker WSS 连接超时")), 15_000);
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as WorkerNodeServerMessage;
        if (message.type === "worker.hello") {
          clearTimeout(timeout);
          this.send({ type: "worker.capabilities", capabilities: this.capabilities() });
          this.pull();
          resolve();
        }
        if (message.type === "worker.assignment") void this.execute(message.assignment);
        if (message.type === "worker.cancel") {
          const handle = this.handles.get(message.attemptId);
          if (handle)
            void handle.stop().finally(() => this.fail(message.attemptId, message.fence, "控制面取消", false));
        }
        if (message.type === "worker.error") console.error(`[worker-node] ${message.code}: ${message.message}`);
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      socket.on("close", (code) => {
        if (this.socket === socket) this.socket = null;
        if (!this.stopping && code !== 4003) {
          this.reconnectTimer = setTimeout(() => void this.connect().catch(() => {}), 1500);
        }
      });
    });
  }

  private async execute(assignment: WorkerAssignment): Promise<void> {
    const { attempt, workItem, plan } = assignment;
    if (this.stopping || this.handles.has(attempt.id)) return;
    let handle: WorkerHandle | null = null;
    let seq = 0;
    try {
      const workspace = await this.git.prepare(workItem.id, workItem.repo, assignment.baseSha ?? undefined);
      if (assignment.recoveryBundle) {
        const recovered = await this.git.reconcile(workspace);
        if (recovered.status === "committed" && recovered.commitSha) {
          const report = assignment.recoveryBundle.payload.report ?? {
            status: "ready" as const,
            summary: "RecoveryBundle 对账发现既有本地 commit",
            tests: [],
          };
          await this.complete(attempt, report, recovered.commitSha, await this.git.diff(workspace), undefined, true);
          return;
        }
        if (recovered.status === "unknown") {
          await this.fail(attempt.id, attempt.fence, "RecoveryBundle 需要人工对账，未盲目重跑", false);
          return;
        }
      }
      this.send({
        type: "worker.assignmentAck",
        attemptId: attempt.id,
        fence: attempt.fence,
        workspace: {
          worktreePath: workspace.worktreePath,
          branch: workspace.branch,
          baseSha: workspace.baseSha,
          mirrorPath: workspace.mirrorPath,
          sourcePath: workspace.sourcePath,
        },
        pid: process.pid,
      });
      handle = await this.runner.start(
        {
          attempt,
          item: {
            ...workItem,
            workerSessionFile: workItem.workerSessionFile ?? null,
            worktreePath: workItem.worktreePath ?? null,
            branch: workItem.branch ?? null,
            baseSha: workItem.baseSha ?? null,
            commitSha: workItem.commitSha ?? null,
            diff: workItem.diff ?? null,
            report: workItem.report ?? null,
            lastError: workItem.lastError ?? null,
          } satisfies ManagedWorkItem,
          workspace,
          plan,
        },
        (eventSeq, eventType, payload) => {
          seq = Math.max(seq, eventSeq);
          this.send({ type: "worker.event", attemptId: attempt.id, fence: attempt.fence, seq, eventType, payload });
        },
      );
      this.handles.set(attempt.id, handle);
      const outcome = await handle.done;
      const logArtifactId = await this.uploadIfPresent(attempt.id, attempt.fence, outcome.logPath);
      if (assignment.role === "plan") {
        if (!outcome.planContent) throw new Error("计划 Worker 未生成 PlanRevision");
        this.send({
          type: "worker.complete",
          attemptId: attempt.id,
          fence: attempt.fence,
          report: { status: "ready", summary: "计划已生成", tests: [] },
          planContent: outcome.planContent,
          logArtifactId,
        });
        return;
      }
      if (!outcome.report || !plan) throw new Error("执行 Worker 未返回结构化报告");
      if (outcome.report.status !== "ready") {
        this.send({
          type: "worker.complete",
          attemptId: attempt.id,
          fence: attempt.fence,
          report: outcome.report,
          logArtifactId,
        });
        return;
      }
      const committed = await verifyAndCommitWorkspace(this.git, workspace, plan, outcome.report);
      const diffArtifactId = await this.upload(
        attempt.id,
        attempt.fence,
        `${committed.diff.stat}\n\n${committed.diff.patch}\n`,
      );
      await this.complete(
        attempt,
        committed.report,
        committed.sha,
        committed.diff,
        diffArtifactId,
        false,
        logArtifactId,
      );
    } catch (error) {
      await this.fail(attempt.id, attempt.fence, error instanceof Error ? error.message : String(error), false);
    } finally {
      if (handle) await handle.stop().catch(() => {});
      this.handles.delete(attempt.id);
    }
  }

  private async complete(
    attempt: { id: string; fence: number },
    report: WorkerWorkReport,
    commitSha: string,
    diff: unknown,
    diffArtifactId?: string,
    recovered = false,
    logArtifactId?: string,
  ): Promise<void> {
    this.send({
      type: "worker.complete",
      attemptId: attempt.id,
      fence: attempt.fence,
      report,
      commitSha,
      diff,
      diffArtifactId,
      logArtifactId,
      recovered,
    });
  }

  private async fail(attemptId: string, fence: number, error: string, retry: boolean): Promise<void> {
    this.send({ type: "worker.fail", attemptId, fence, error, retry });
  }

  private async uploadIfPresent(attemptId: string, fence: number, file?: string): Promise<string | undefined> {
    if (!file || !existsSync(file)) return undefined;
    return this.upload(attemptId, fence, readFileSync(file));
  }

  private async upload(attemptId: string, fence: number, content: string | Buffer): Promise<string> {
    if (!this.credentials) throw new Error("Worker 尚未配对");
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (body.byteLength === 0) return "";
    const response = await fetch(new URL("/api/v1/worker-node/artifacts", this.credentials.controlUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.credentials.nodeId}:${this.credentials.nodeToken}`,
        "X-Spcode-Attempt-Id": attemptId,
        "X-Spcode-Fence": String(fence),
        "X-Spcode-Sha256": sha256(body),
        "X-Spcode-Control-Client": "1",
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Artifact 上传失败：${response.status}`);
    const result = (await response.json()) as { id: string };
    return result.id;
  }

  private capabilities(): WorkerNodeCapabilities {
    return {
      platform: process.platform,
      hostname: hostname(),
      capacity: this.options.capacity ?? 1,
      repos: [],
      models: [],
    };
  }

  private heartbeat(): void {
    this.send({
      type: "worker.heartbeat",
      activeAttempts: this.handles.size,
      freeCapacity: Math.max(0, (this.options.capacity ?? 1) - this.handles.size),
    });
  }

  private pull(): void {
    this.send({ type: "worker.pull", maxItems: this.options.capacity ?? 1 });
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}
