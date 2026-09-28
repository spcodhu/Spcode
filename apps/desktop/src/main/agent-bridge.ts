/**
 * AgentBridge —— 主进程与 agent-host(utilityProcess) 之间的桥。
 *
 * - 负责 spawn/守护宿主进程，崩溃自动重启并上报
 * - 命令-响应按 id 关联（Promise 化）
 * - 权限请求按风险策略就地裁决或转发渲染进程
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

type EventListener = (event: HostEvent) => void;

export class AgentBridge {
  private child: UtilityProcess | null = null;
  private readyPromise: Promise<void> | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<EventListener>();
  /** 渲染进程未决的权限请求 */
  private pendingPermissions = new Map<string, PermissionRequest>();
  private getPermissionMode: () => PermissionMode;

  constructor(opts: { getPermissionMode: () => PermissionMode }) {
    this.getPermissionMode = opts.getPermissionMode;
  }

  /** 订阅宿主事件（session.event / usage / host.error 等） */
  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
        this.broadcast({ type: "host.error", message: err.message });
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
    this.pendingPermissions.set(request.requestId, request);
    this.broadcast({ type: "permission.request", request });
  }

  /** 渲染进程回复权限确认 */
  replyPermission(requestId: string, approved: boolean): void {
    if (!this.pendingPermissions.delete(requestId)) return;
    this.post({ type: "permission.reply", payload: { requestId, approved } });
  }

  private post(cmd: HostCommand): void {
    this.child?.postMessage(cmd);
  }

  /** 发送带 id 的命令并等待响应 */
  async call<T = unknown>(cmd: Extract<HostCommand, { id: string }>): Promise<T> {
    await this.start();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(cmd.id, { resolve: resolve as (v: unknown) => void, reject });
      this.post(cmd);
    });
  }

  /** 便捷方法：构造带新 id 的命令 */
  static withId<T extends Omit<Extract<HostCommand, { id: string }>, "id">>(cmd: T): T & { id: string } {
    return { ...cmd, id: randomUUID() };
  }

  bindWindow(wc: WebContents): () => void {
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
