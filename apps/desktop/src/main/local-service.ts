import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostEvent } from "@spcode/shared";
import { resolveSpcodeHome } from "@spcode/shared/node";
import WebSocket from "ws";
import { type ControlRuntimeInfo, readRuntimeInfo } from "../../../control-plane/src/discovery.js";

export interface LocalServiceOptions {
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
  enabled: boolean;
  invoke(method: string, args: unknown[]): Promise<unknown>;
}

/** Electron 只负责本地服务发现、拉起、健康检查与旧 IPC 传输适配。 */
export class LocalService {
  private readonly baseDir = join(resolveSpcodeHome(), "superagent");
  private runtime: ControlRuntimeInfo | null = null;
  private socket: WebSocket | null = null;
  private active = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: LocalServiceOptions) {}

  async start(): Promise<boolean> {
    if (!this.options.enabled) return false;
    this.active = true;
    this.runtime = await this.discoverHealthy();
    if (!this.runtime) {
      await this.spawn();
      this.runtime = await this.waitForHealthy();
    }
    if (!this.runtime) {
      this.active = false;
      return false;
    }
    this.connect();
    return true;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  workbenchUrl(view: "session" | "superagent"): string | null {
    if (!this.runtime) return null;
    try {
      const token = readFileSync(join(this.baseDir, "device-token"), "utf8").trim();
      if (!token) return null;
      return `http://127.0.0.1:${this.runtime.port}/?view=${view}#bootstrap=${encodeURIComponent(token)}`;
    } catch {
      return null;
    }
  }

  publishHostEvent(event: HostEvent): void {
    if (this.connected) this.socket?.send(JSON.stringify({ type: "desktop.event", event }));
  }

  /** 只断开 Electron 适配器；独立控制面与 SuperAgent 任务继续运行。 */
  stop(): void {
    this.active = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close(1000, "desktop shutting down");
    this.socket = null;
  }

  private async discoverHealthy(): Promise<ControlRuntimeInfo | null> {
    const runtime = readRuntimeInfo(this.baseDir);
    if (!runtime) return null;
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.port}/api/v1/health`, {
        signal: AbortSignal.timeout(1200),
        headers: { "X-Spcode-Control-Client": "1" },
      });
      if (!response.ok) return null;
      const health = (await response.json()) as { pid?: number; protocolVersion?: number };
      return health.pid === runtime.pid && health.protocolVersion === 1 ? runtime : null;
    } catch {
      return null;
    }
  }

  private async spawn(): Promise<void> {
    const entry = this.options.isPackaged
      ? join(this.options.resourcesPath, "control-plane", "index.mjs")
      : join(this.options.appPath, "../control-plane/dist/index.mjs");
    const workbenchDir = this.options.isPackaged
      ? join(this.options.resourcesPath, "workbench")
      : join(this.options.appPath, "../workbench/dist");
    if (!existsSync(entry)) throw new Error(`本地控制面入口不存在：${entry}`);
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    const log = openSync(join(this.baseDir, "control-plane.log"), "a");
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        SPCODE_HOME: resolveSpcodeHome(),
        SPCODE_WORKBENCH_DIR: workbenchDir,
        SPCODE_CONTROL_PORT: process.env.SPCODE_CONTROL_PORT ?? "47831",
      },
    });
    child.on("error", (error) => console.error("[local-service] 控制面启动失败", error));
    child.unref();
  }

  private async waitForHealthy(): Promise<ControlRuntimeInfo | null> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const runtime = await this.discoverHealthy();
      if (runtime) return runtime;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  private connect(): void {
    if (!this.active || !this.runtime || this.socket) return;
    const socket = new WebSocket(`ws://127.0.0.1:${this.runtime.port}/api/v1/desktop`, {
      headers: { Authorization: `Bearer ${this.runtime.serviceToken}` },
      maxPayload: 25 * 1024 * 1024,
    });
    this.socket = socket;
    socket.on("message", (data) => void this.accept(data.toString()));
    socket.on("error", (error) => console.warn("[local-service] 控制面连接异常", error.message));
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      if (this.active && !this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          // 服务可能已换端口或 serviceToken；必须重新发现，而不是永久重连旧地址。
          void this.start().catch((error) => console.warn("[local-service] 控制面重连失败", error));
        }, 1500);
      }
    });
  }

  private async accept(raw: string): Promise<void> {
    let message: { type?: string; id?: string; method?: string; args?: unknown[] };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type !== "desktop.invoke" || !message.id || typeof message.method !== "string") return;
    try {
      const result = await this.options.invoke(message.method, Array.isArray(message.args) ? message.args : []);
      this.socket?.send(JSON.stringify({ type: "desktop.response", id: message.id, ok: true, result }));
    } catch (error) {
      this.socket?.send(
        JSON.stringify({
          type: "desktop.response",
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
