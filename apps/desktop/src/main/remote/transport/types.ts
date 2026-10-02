/**
 * 远程控制 Transport 抽象（设计文档 4.4：控制面与传输层解耦）。
 * M1 只有 lan 实现；M2 relay、M3 tailscale 实现同一接口。
 */

/** 一条对端连接（手机 PWA 的 WebSocket） */
export interface PeerConnection {
  readonly id: string;
  /** 发送 JSON 帧（RemoteWireFrame；连接已关闭时静默丢弃） */
  send(frame: unknown): void;
  /** 收到的 JSON 帧（未解析为协议类型前为 unknown；非 JSON 帧已被传输层丢弃） */
  onMessage(cb: (frame: unknown) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface RemoteTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  onConnection(cb: (peer: PeerConnection) => void): void;
  /** 对外可访问的 base url 列表（如 http://192.168.1.5:8123）；未启动时为空 */
  getAdvertisedUrls(): string[];
}
