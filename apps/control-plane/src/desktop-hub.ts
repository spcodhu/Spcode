import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { HostEvent } from "@spcode/shared";
import { WebSocket, type WebSocketServer } from "ws";
import { tokensEqual } from "./auth.js";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** 旧桌面 IPC 的传输适配器；SuperAgent 业务事实不经过这里。 */
export class DesktopHub {
  private desktop: WebSocket | null = null;
  private readonly browsers = new Set<WebSocket>();
  private readonly pending = new Map<string, PendingCall>();

  constructor(
    private readonly serviceToken: string,
    private readonly onHostEvent: (event: HostEvent) => void,
  ) {}

  get connected(): boolean {
    return this.desktop?.readyState === WebSocket.OPEN;
  }

  handleDesktopUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer): void {
    const authorization = request.headers.authorization ?? "";
    if (!authorization.startsWith("Bearer ") || !tokensEqual(authorization.slice(7), this.serviceToken)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (this.desktop) this.desktop.close(1000, "replaced by newer desktop");
      this.desktop = ws;
      ws.on("message", (data) => this.acceptDesktopMessage(data.toString()));
      ws.on("close", () => {
        if (this.desktop === ws) {
          this.desktop = null;
          this.rejectAll(new Error("桌面适配器已断开"));
          this.broadcast({ type: "desktop.status", connected: false });
        }
      });
      ws.on("error", () => {});
      ws.send(JSON.stringify({ type: "desktop.ready", protocolVersion: 1 }));
      this.broadcast({ type: "desktop.status", connected: true });
    });
  }

  handleBrowserUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer): void {
    wss.handleUpgrade(request, socket, head, (ws) => {
      this.browsers.add(ws);
      ws.on("close", () => this.browsers.delete(ws));
      ws.on("error", () => this.browsers.delete(ws));
      ws.send(JSON.stringify({ type: "control.hello", protocolVersion: 1, desktopConnected: this.connected }));
    });
  }

  invoke(method: string, args: unknown[]): Promise<unknown> {
    if (!this.desktop || this.desktop.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("桌面适配器未连接；SuperAgent 页面仍可使用，旧会话功能请先启动 Electron"));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`桌面适配器调用超时：${method}`));
      }, 180_000);
      this.pending.set(id, { resolve, reject, timer });
      this.desktop?.send(JSON.stringify({ type: "desktop.invoke", id, method, args }));
    });
  }

  publish(sequence: number, workItemId?: string): void {
    this.broadcast({ type: "superagent.changed", sequence, ...(workItemId ? { workItemId } : {}), at: Date.now() });
  }

  close(): void {
    this.rejectAll(new Error("控制面正在停止"));
    for (const ws of this.browsers) ws.close(1001, "control plane stopping");
    this.browsers.clear();
    this.desktop?.close(1001, "control plane stopping");
    this.desktop = null;
  }

  private acceptDesktopMessage(raw: string): void {
    let message: { type?: string; id?: string; ok?: boolean; result?: unknown; error?: string; event?: HostEvent };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === "desktop.event" && message.event) {
      this.onHostEvent(message.event);
      this.broadcast({ type: "host.event", event: message.event });
      return;
    }
    if (message.type !== "desktop.response" || !message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "桌面适配器调用失败"));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private broadcast(event: unknown): void {
    const raw = JSON.stringify(event);
    for (const ws of this.browsers) {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
    }
  }
}
