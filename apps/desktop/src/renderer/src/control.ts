import { ControlClient } from "@spcode/shared/control-client";

export type ControlStreamEvent =
  | { type: "control.hello"; protocolVersion: number; desktopConnected: boolean }
  | { type: "desktop.status"; connected: boolean }
  | { type: "superagent.changed"; sequence: number; workItemId?: string; at: number }
  | { type: "host.event"; event: import("@spcode/shared").HostEvent };

let controlClient: ControlClient | null = null;
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const streamListeners = new Set<(event: ControlStreamEvent) => void>();

/** Electron 与浏览器都初始化同一控制面 SDK；preload 只决定是否额外拥有原生能力。 */
export async function initializeControlTransport(): Promise<ControlClient | null> {
  if (location.protocol !== "http:" && location.protocol !== "https:") return null;
  const loopback = location.hostname === "127.0.0.1" || location.hostname === "localhost";
  if (location.protocol === "http:" && !loopback) return null;
  controlClient = new ControlClient();
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const token = hash.get("bootstrap");
  if (token) {
    // fragment 不参与 HTTP 请求；换到 HttpOnly Cookie 后立即从地址栏与历史记录中移除。
    try {
      await controlClient.login(token).catch(() => {});
    } finally {
      hash.delete("bootstrap");
      const nextHash = hash.toString();
      history.replaceState(null, "", `${location.pathname}${location.search}${nextHash ? `#${nextHash}` : ""}`);
    }
  }
  return controlClient;
}

export function getControlClient(): ControlClient {
  if (!controlClient) throw new Error("当前入口不是本地控制面工作台");
  return controlClient;
}

export function subscribeControlEvents(listener: (event: ControlStreamEvent) => void): () => void {
  streamListeners.add(listener);
  ensureStream();
  return () => {
    streamListeners.delete(listener);
    if (streamListeners.size === 0) {
      reconnectTimer && clearTimeout(reconnectTimer);
      reconnectTimer = null;
      socket?.close();
      socket = null;
    }
  };
}

function ensureStream(): void {
  if (socket || reconnectTimer || streamListeners.size === 0) return;
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}/api/v1/events`);
  socket.onmessage = (message) => {
    try {
      const event = JSON.parse(String(message.data)) as ControlStreamEvent;
      if (typeof event?.type !== "string") return;
      for (const listener of streamListeners) listener(event);
    } catch {
      // 单个坏帧不污染本地事实；SuperAgent 始终可重新拉取权威快照。
    }
  };
  socket.onclose = () => {
    socket = null;
    if (streamListeners.size > 0) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        ensureStream();
      }, 1500);
    }
  };
  socket.onerror = () => socket?.close();
}
