/**
 * 远程控制协议（手机 PWA / 飞书等通道 ↔ harness 主进程）——设计文档 4.2/4.3 节。
 *
 * 分层：
 * - RemoteCommand / RemoteEvent：加密层（NaCl box）内传输的业务 JSON；
 * - RemoteClientHello / RemoteServerHello：连接建立时的明文控制帧（pair / auth）；
 * - RemoteEncryptedFrame：配对完成后所有业务流量的统一信封（base64 密文 + 单调 seq）。
 *
 * 本文件只放纯类型，禁止引入任何运行时依赖（同 index.ts 约定）。
 */

import type {
  ModelRef,
  PermissionRequest,
  QuestionRequest,
  ScheduleTask,
  ScheduleTaskInput,
  SessionMeta,
  SessionMode,
  TodoItem,
  UsageRecord,
} from "./index.js";

// ---------------------------------------------------------------------------
// 业务消息（加密层内明文形态）
// ---------------------------------------------------------------------------

/** 手机 → 桌面 */
export type RemoteCommand =
  | { type: "session.list" }
  | { type: "session.create"; mode: SessionMode; cwd?: string; prompt: string; model?: ModelRef }
  /** 空闲 = 正常输入；运行中 = steer 插话（宿主侧无需特判） */
  | { type: "session.prompt"; sessionId: string; text: string }
  | { type: "session.abort"; sessionId: string }
  /** 订阅某会话事件流（M1：所有事件本就广播给全部已配对设备，返回 ok 即可） */
  | { type: "session.subscribe"; sessionId: string }
  | { type: "permission.reply"; requestId: string; approved: boolean }
  | { type: "question.reply"; requestId: string; answers: Record<string, string> }
  | { type: "schedule.list" }
  | { type: "schedule.create"; input: ScheduleTaskInput }
  | { type: "schedule.update"; id: string; patch: Partial<ScheduleTaskInput> }
  | { type: "schedule.remove"; id: string }
  | { type: "schedule.runNow"; id: string };

/** 桌面 → 手机 */
export type RemoteEvent =
  /** 连接/配对成功后的全量快照 */
  | { type: "session.snapshot"; sessions: SessionMeta[] }
  | { type: "session.status"; sessionId: string; status: "running" | "idle" | "waiting_permission" }
  /** 节流聚合（约 400ms 窗口）后的输出增量；seq 每会话单调递增 */
  | { type: "session.output"; sessionId: string; chunk: string; seq: number; kind?: "text" | "thinking" }
  | { type: "session.todo"; sessionId: string; todos: TodoItem[] }
  | { type: "session.usage"; sessionId: string; usage: UsageRecord }
  | { type: "session.renamed"; sessionId: string; title: string }
  | { type: "session.planmode"; sessionId: string; enabled: boolean }
  /** 含 risk 级别；danger 级手机端必须强确认 UI */
  | { type: "permission.request"; request: PermissionRequest }
  | { type: "question.request"; request: QuestionRequest }
  | { type: "schedule.fired"; taskId: string; name: string; sessionId: string }
  | { type: "sessions.changed" };

// ---------------------------------------------------------------------------
// 配对握手（连接后第一帧，明文控制帧）
// ---------------------------------------------------------------------------

/** 手机 → 桌面：连接建立后发送的第一个帧 */
export type RemoteClientHello =
  /**
   * 新设备配对：c = base64( secretbox( JSON(PairHelloInner), key = sha256("spcode-remote-pair-v1:" + otp) ) )
   * secretbox 输出布局：nonce(24B) ‖ ciphertext
   */
  | { t: "pair"; otp: string; c: string }
  /** 已配对设备身份证明：未知公钥直接断开 */
  | { t: "auth"; publicKey: string };

/** 桌面 → 手机：hello 帧的应答 */
export type RemoteServerHello =
  /** c = base64( box( JSON(PairAckInner), nonce, phonePublicKey, desktopSecretKey ) )，布局 nonce(24B) ‖ ciphertext */
  | { t: "pair_ack"; ok: true; c: string }
  /** error: "locked"（错误超限锁定）| "expired"（窗口过期/未开启）| "otp_mismatch" | "bad_payload" */
  | { t: "pair_ack"; ok: false; error: string }
  | { t: "auth_ack"; ok: true; desktopPk: string }
  | { t: "auth_ack"; ok: false; error: string };

/** PairHello 密文内明文（手机公钥 + 设备名） */
export interface PairHelloInner {
  /** 手机的 X25519 公钥（base64，32 字节） */
  publicKey: string;
  name: string;
}

/** PairAck 密文内明文（桌面公钥 + 分配的设备 id） */
export interface PairAckInner {
  desktopPk: string;
  deviceId: string;
}

// ---------------------------------------------------------------------------
// 加密业务帧
// ---------------------------------------------------------------------------

/** 配对完成后所有业务流量的信封：c = base64( nonce(24B) ‖ box(JSON(RemoteEncryptedPayload)) ) */
export interface RemoteEncryptedFrame {
  /** 帧 id（命令帧由发送方生成，响应用同 id 关联） */
  id: string;
  /** 每连接每方向单调递增（从 0 开始），防重放 */
  seq: number;
  t: "encrypted";
  c: string;
}

export type RemoteWireFrame = RemoteClientHello | RemoteServerHello | RemoteEncryptedFrame;

/** 加密帧解密后的载荷 */
export type RemoteEncryptedPayload =
  | { kind: "command"; command: RemoteCommand }
  | { kind: "event"; event: RemoteEvent }
  | { kind: "response"; id: string; ok: boolean; data?: unknown; error?: string };

// ---------------------------------------------------------------------------
// 设备记录与状态（持久化 + IPC）
// ---------------------------------------------------------------------------

export interface PairedDevice {
  id: string;
  name: string;
  /** X25519 公钥（base64） */
  publicKey: string;
  pairedAt: number;
}

/** 设置项：远程控制开关与监听端口（null = 随机端口） */
export interface RemoteSettings {
  enabled: boolean;
  port: number | null;
}

/** 当前有效的配对窗口（OTP 单次有效，5 分钟过期） */
export interface RemotePairingInfo {
  otp: string;
  /**
   * QR payload：
   *   spcode-remote://pair?v=1&hosts=<逗号分隔的 base url,URL编码>&desktop_pk=<base64>&otp=<8位数字>
   * 例：spcode-remote://pair?v=1&hosts=http%3A%2F%2F192.168.1.5%3A8123&desktop_pk=…&otp=12345678
   */
  qrPayload: string;
  expiresAt: number;
  urls: string[];
}

/** getRemoteStatus IPC 的返回结构 */
export interface RemoteStatus {
  enabled: boolean;
  /** 局域网可访问地址（http://ip:port）；未启动时为空 */
  urls: string[];
  devices: PairedDevice[];
  pairing: RemotePairingInfo | null;
}
