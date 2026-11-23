import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostCommand, HostEvent, ModelRef, SessionInfo } from "@spcode/shared";
import { DEFAULT_COMPACTION_SETTINGS, DEFAULT_SANDBOX_SETTINGS } from "@spcode/shared";
import { resolveSpcodeHome } from "@spcode/shared/node";
import type { AttemptSnapshot, PlanRevision, WorkerWorkReport } from "@spcode/shared/superagent";
import type { GitWorkspace } from "./git-workspace.js";
import { workerEnvironment } from "./git-workspace.js";
import type { ManagedWorkItem } from "./worker-store.js";

const here = dirname(fileURLToPath(import.meta.url));

export interface WorkerRunInput {
  attempt: AttemptSnapshot;
  item: ManagedWorkItem;
  workspace: GitWorkspace;
  plan: PlanRevision | null;
  model?: ModelRef;
}

export interface WorkerRunOutcome {
  planContent?: string;
  report?: WorkerWorkReport;
  question?: unknown;
  logPath: string;
}

export interface WorkerHandle {
  pid: number;
  done: Promise<WorkerRunOutcome>;
  stop(): Promise<void>;
}

export interface WorkerRunner {
  start(input: WorkerRunInput, onEvent: (seq: number, type: string, payload: unknown) => void): Promise<WorkerHandle>;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type WorkerCommandInput = HostCommand extends infer Command
  ? Command extends { id: string }
    ? Omit<Command, "id">
    : never
  : never;

/** 每 Attempt 一个独立 Node 进程；等待审批/停止时物理进程完全退出。 */
export class NodeWorkerRunner implements WorkerRunner {
  constructor(
    readonly baseDir: string,
    private readonly entry = resolve(here, "../dist/agent-runtime.mjs"),
    private readonly extraEnv: Record<string, string> = {},
  ) {}

  async start(
    input: WorkerRunInput,
    onEvent: (seq: number, type: string, payload: unknown) => void,
  ): Promise<WorkerHandle> {
    mkdirSync(join(this.baseDir, "logs"), { recursive: true });
    const logPath = join(this.baseDir, "logs", `${input.attempt.id}.log`);
    const log = createWriteStream(logPath, { flags: "a" });
    const child = fork(this.entry, [], {
      cwd: input.workspace.worktreePath,
      execArgv: [],
      env: workerEnvironment({
        SPCODE_WORKER_ROLE: input.attempt.role,
        SPCODE_WORK_ITEM_ID: input.item.id,
        SPCODE_ATTEMPT_ID: input.attempt.id,
        SPCODE_WORKTREE: input.workspace.worktreePath,
        SPCODE_BASE_SHA: input.workspace.baseSha,
        ...this.extraEnv,
      }),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    if (!child.pid) throw new Error("Worker 进程启动失败");
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    return this.attach(child, input, logPath, onEvent);
  }

  private attach(
    child: ChildProcess,
    input: WorkerRunInput,
    logPath: string,
    onEvent: (seq: number, type: string, payload: unknown) => void,
  ): WorkerHandle {
    const pending = new Map<string, PendingCall>();
    let seq = 0;
    let ready = false;
    let settled = false;
    let intentionallyStopped = false;
    let planPath: string | null = null;
    let report: WorkerWorkReport | undefined;
    let question: unknown;
    let resolveDone!: (value: WorkerRunOutcome) => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<WorkerRunOutcome>((resolveDonePromise, rejectDonePromise) => {
      resolveDone = resolveDonePromise;
      rejectDone = rejectDonePromise;
    });

    const call = <T = unknown>(command: WorkerCommandInput): Promise<T> => {
      const id = randomUUID();
      return new Promise<T>((resolveCall, rejectCall) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectCall(new Error(`Worker 命令超时：${command.type}`));
        }, 30 * 60_000);
        pending.set(id, { resolve: resolveCall as (value: unknown) => void, reject: rejectCall, timer });
        child.send({ ...command, id });
      });
    };
    const push = (command: HostCommand) => child.send(command);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error("Worker 已结束"));
      }
      pending.clear();
      callback();
    };

    child.on("message", (message: HostEvent) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "ready") {
        ready = true;
        return;
      }
      if (message.type === "response") {
        const call = pending.get(message.id);
        if (!call) return;
        pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.success) call.resolve(message.data);
        else call.reject(new Error(message.error || "Worker 命令失败"));
        return;
      }
      seq++;
      onEvent(seq, message.type, message);
      if (message.type === "session.plan") planPath = message.path;
      if (message.type === "session.workReport") report = message.report;
      if (message.type === "question.request") {
        question = message.request;
        push({ type: "question.reply", payload: { requestId: message.request.requestId, answers: {} } });
      }
      if (message.type === "permission.request") {
        // Worker 不继承桌面免审；无人值守时 outward/danger/bypass 默认拒绝并留下证据。
        push({ type: "permission.reply", payload: { requestId: message.request.requestId, approved: false } });
      }
    });
    child.once("error", (error) => finish(() => rejectDone(error)));
    child.once("exit", (code, signal) => {
      if (!settled && !intentionallyStopped) {
        finish(() => rejectDone(new Error(`Worker 异常退出：code=${code} signal=${signal}`)));
      }
    });

    void (async () => {
      const deadline = Date.now() + 30_000;
      while (!ready) {
        if (settled) return;
        if (Date.now() > deadline) throw new Error("Worker ready 超时");
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      push({ type: "memory.setDistillEnabled", payload: { enabled: false } });
      push({ type: "subagent.setMode", payload: { mode: "off" } });
      push({ type: "modelCatalog.setAutoSync", payload: { enabled: false } });
      push({ type: "mcp.setServers", payload: { servers: {} } });
      push({ type: "sandbox.setConfig", payload: { config: DEFAULT_SANDBOX_SETTINGS } });
      push({ type: "compaction.setConfig", payload: { config: DEFAULT_COMPACTION_SETTINGS } });
      let info: SessionInfo;
      if (input.item.workerSessionFile) {
        info = await call<SessionInfo>({
          type: "session.open",
          payload: {
            sessionId: input.item.id,
            sessionFile: input.item.workerSessionFile,
            cwd: input.workspace.worktreePath,
            planMode: input.attempt.role === "plan",
            permissionMode: "auto",
          },
        });
      } else {
        info = await call<SessionInfo>({
          type: "session.create",
          payload: {
            sessionId: input.item.id,
            mode: "project",
            cwd: input.workspace.worktreePath,
            ...(input.model ? { model: input.model } : {}),
            permissionMode: "auto",
          },
        });
      }
      if (input.attempt.role === "plan") {
        await call({ type: "session.setPlanMode", payload: { sessionId: input.item.id, enabled: true } });
      }
      if (info.sessionFile && info.sessionFile !== input.item.workerSessionFile) {
        onEvent(++seq, "session.file", { sessionFile: info.sessionFile });
      }
      if (input.attempt.role === "plan") {
        await call({
          type: "session.prompt",
          payload: {
            sessionId: input.item.id,
            text: `请为以下授权工作生成只读计划。仓库：${input.item.repo}\nbaseSha：${input.workspace.baseSha}\n需求：${input.item.request}\n\n计划必须包含 Markdown 二级标题“验证命令”和“拟改范围”，验证命令每行一条、必须真实可执行；同时说明 commit/publish/effect 意图与风险。只读调研结束后调用 WritePlan，禁止修改仓库。`,
          },
        });
      } else {
        await call({
          type: "session.prompt",
          payload: {
            sessionId: input.item.id,
            text: `执行下面已批准的计划，不得扩大范围，不得执行任何 Git 写命令。完成后运行验证并调用 ReportWork。\n\n${input.plan?.content ?? ""}`,
          },
        });
      }
      const planContent = planPath ? readFileSync(planPath, "utf8") : undefined;
      finish(() =>
        resolveDone({
          ...(planContent ? { planContent } : {}),
          ...(report ? { report } : {}),
          ...(question ? { question } : {}),
          logPath,
        }),
      );
    })().catch((error) => finish(() => rejectDone(error instanceof Error ? error : new Error(String(error)))));

    return {
      pid: child.pid!,
      done,
      stop: async () => {
        if (intentionallyStopped || child.exitCode !== null || child.signalCode !== null) return;
        intentionallyStopped = true;
        try {
          push({ type: "shutdown" });
        } catch {
          // 进程已退出。
        }
        const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
        await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 1500))]);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 1500))]);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        finish(() => rejectDone(new Error("Worker 已停止")));
      },
    };
  }
}

export function createDefaultWorkerRunner(baseDir: string, homeDir = resolveSpcodeHome()): WorkerRunner {
  const fake = process.env.SPCODE_SUPERAGENT_FAKE_WORKER === "1";
  return new NodeWorkerRunner(
    baseDir,
    fake ? resolve(here, "../dist/fake-worker.mjs") : resolve(here, "../dist/agent-runtime.mjs"),
    { SPCODE_HOME: homeDir },
  );
}
