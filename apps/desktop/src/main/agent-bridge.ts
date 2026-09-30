/**
 * AgentBridge —— 主进程与 agent-host(utilityProcess) 之间的桥。
 *
 * - 负责 spawn 宿主进程；崩溃后拒绝全部在途命令、广播 fatal host.error，
 *   下一次 call() 时惰性重启（会话状态随宿主进程存亡，重启不恢复在途会话）
 * - 命令-响应按 id 关联（Promise 化，默认 30s 超时）
 * - 权限请求按风险策略就地裁决或转发渲染进程（10 分钟无人裁决自动拒绝）
 * - 会话事件/用量事件广播给所有窗口
 */
import { utilityProcess, type UtilityProcess, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IPC,
  type HostCommand,
  type HostEvent,
  type PermissionRequest,
  type PermissionMode,
} from "@spcode/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 权限请求转发渲染进程后的裁决超时：超时按拒绝回执宿主（评审 P1-1） */
const PERMISSION_TIMEOUT_MS = 10 * 60_000;

/** 命令-响应默认超时（评审 P1-8）；长调用（如 theme.generate 跑模型）由调用方覆盖 */
const CALL_TIMEOUT_MS = 30_000;

type EventListener = (event: HostEvent) => void;

export class AgentBridge {
  private child: UtilityProcess | null = null;
  private readyPromise: Promise<void> | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<EventListener>();
  /** 渲染进程未决的权限请求（带超时兜底——评审 P1-1） */
  private pendingPermissions = new Map<string, { request: PermissionRequest; timer: ReturnType<typeof setTimeout> }>();
  private getPermissionMode: () => PermissionMode;

  constructor(opts: { getPermissionMode: () => PermissionMode }) {
    this.getPermissionMode = opts.getPermissionMode;
  }

  /** 订阅宿主事件（session.event / usage / host.error 等） */
  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 主进程本地产生的事件（定时任务触发等）广播给所有监听者与绑定窗口 */
  emitLocal(event: HostEvent): void {
    this.broadcast(event);
  }

  private broadcast(event: HostEvent): void {
    for (const l of this.listeners) l(event);
  }

  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolveReady, rejectReady) => {
      const entry = join(__dirname, "agent-host.mjs");
      const child = utilityProcess.fork(entry, [], {
        serviceName: "spcode-agent-host",
        stdio: "pipe",
      });
      this.child = child;

      const onEvent = (event: HostEvent) => {
        if (event.type === "ready") {
          // ready 也广播给监听者：宿主重启后主进程需要据此重推设置等运行时状态
          this.broadcast(event);
          resolveReady();
          return;
        }
        this.routeEvent(event);
      };
      child.on("message", (msg: unknown) => onEvent(msg as HostEvent));
      child.stderr?.on("data", (d: Buffer) => {
        console.error("[agent-host]", d.toString());
      });
      child.once("exit", (code) => {
        console.error(`[agent-bridge] host exited with code ${code}`);
        this.child = null;
        this.readyPromise = null;
        const err = new Error(`agent-host exited (code ${code})`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        // 宿主已死，其内的权限请求随之蒸发；清掉转发记录，避免重启后错配
        for (const p of this.pendingPermissions.values()) clearTimeout(p.timer);
        this.pendingPermissions.clear();
        this.broadcast({ type: "host.error", message: err.message, fatal: true });
      });
      child.once("error", (e) => rejectReady(e));
    });
    return this.readyPromise;
  }

  private routeEvent(event: HostEvent): void {
    if (event.type === "response") {
      const p = this.pending.get(event.id);
      if (p) {
        this.pending.delete(event.id);
        if (event.success) p.resolve(event.data);
        else p.reject(new Error(event.error ?? "unknown host error"));
      }
      return;
    }
    if (event.type === "permission.request") {
      this.adjudicate(event.request);
      return;
    }
    this.broadcast(event);
  }

  /** 权限策略：write 在 ask 模式询问、act 模式放行；danger 永远询问 */
  private adjudicate(request: PermissionRequest): void {
    const mode = this.getPermissionMode();
    const needsAsk = request.risk === "danger" || (request.risk === "write" && mode === "ask");
    if (!needsAsk) {
      this.post({ type: "permission.reply", payload: { requestId: request.requestId, approved: true } });
      return;
    }
    // 超时兜底：广播到 0 个窗口（关窗的定时任务场景）时按拒绝收尾，工具调用不会永久挂死
    const timer = setTimeout(() => {
      this.replyPermission(request.requestId, false);
    }, PERMISSION_TIMEOUT_MS);
    this.pendingPermissions.set(request.requestId, { request, timer });
    this.broadcast({ type: "permission.request", request });
  }

  /** 渲染进程回复权限确认 */
  replyPermission(requestId: string, approved: boolean): void {
    const p = this.pendingPermissions.get(requestId);
    if (!p) return;
    this.pendingPermissions.delete(requestId);
    clearTimeout(p.timer);
    this.post({ type: "permission.reply", payload: { requestId, approved } });
  }

  /** 渲染进程回复结构化提问（AskUserQuestion 工具） */
  replyQuestion(requestId: string, answers: Record<string, string>): void {
    this.post({ type: "question.reply", payload: { requestId, answers } });
  }

  private post(cmd: HostCommand): void {
    this.child?.postMessage(cmd);
  }

  /** 推送无需响应的命令（fire-and-forget，如设置下发） */
  push(cmd: HostCommand): void {
    this.post(cmd);
  }

  /** 发送带 id 的命令并等待响应；默认 30s 超时（宿主卡死时 UI 不再无限转圈——评审 P1-8） */
  async call<T = unknown>(cmd: Extract<HostCommand, { id: string }>, opts?: { timeoutMs?: number }): Promise<T> {
    await this.start();
    const timeoutMs = opts?.timeoutMs ?? CALL_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmd.id);
        reject(new Error(`宿主命令 ${cmd.type} 超过 ${Math.round(timeoutMs / 1000)}s 未响应`));
      }, timeoutMs);
      this.pending.set(cmd.id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.post(cmd);
    });
  }

  /** 便捷方法：构造带新 id 的命令 */
  static withId<T extends Omit<Extract<HostCommand, { id: string }>, "id">>(cmd: T): T & { id: string } {
    return { ...cmd, id: randomUUID() };
  }

  bindWindow(wc: WebContents): () => void {
    // 重播未决权限请求：macOS 关窗不退出，新窗口重建后仍应看到等待中的确认卡片
    for (const p of this.pendingPermissions.values()) {
      if (!wc.isDestroyed()) wc.send(IPC.hostEvent, { type: "permission.request", request: p.request });
    }
    return this.onEvent((event) => {
      if (!wc.isDestroyed()) wc.send(IPC.hostEvent, event);
    });
  }

  async dispose(): Promise<void> {
    this.post({ type: "shutdown" });
    this.child?.kill();
    this.child = null;
    this.readyPromise = null;
  }
}
