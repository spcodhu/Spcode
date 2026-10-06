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
  | { type: "schedule.runNow"; id: string }
  /**
   * 注册 Web Push 订阅（M2）：浏览器 PushSubscription 的 JSON 形态
   * （endpoint / keys.p256dh / keys.auth），按 deviceId 存桌面端；
   * 推送 payload 只含无内容提醒，不含任务数据
   */
  | { type: "push.subscribe"; subscription: RemotePushSubscription }
  /** 断线补拉：拉取某会话 seq > afterSeq 的输出 chunk（响应为 session.output.backfill 事件） */
  | { type: "session.output.since"; sessionId: string; afterSeq: number }
  /** 重命名会话（与桌面端同一套注册表逻辑，完成后广播 session.renamed / sessions.changed） */
  | { type: "session.rename"; sessionId: string; title: string }
  /** 删除会话（注册表 + 计划文件 + 宿主实例一并清理，完成后广播 sessions.changed） */
  | { type: "session.remove"; sessionId: string };

/** 桌面 → 手机 */
export type RemoteEvent =
  /**
   * auth / pair 成功后的首个服务端事件：携带 VAPID 公钥（Web Push 订阅用；
   * 未生成时为空串，客户端据此禁用推送开关）
   */
  | { type: "remote.hello"; vapidPublicKey: string }
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
  /**
   * 权限请求已在任一端裁决（M3 双端撤卡）：另一端收到后关闭同 requestId 的批准卡。
   * by = 裁决来源端（"local" 桌面 / "remote" 手机）
   */
  | { type: "permission.resolved"; requestId: string; approved: boolean; by: "local" | "remote" }
  | { type: "question.request"; request: QuestionRequest }
  | { type: "schedule.fired"; taskId: string; name: string; sessionId: string }
  | { type: "sessions.changed" }
  /** 断线补拉响应：session.output.since 的结果，按 seq 升序（只含 > afterSeq 的 chunk） */
  | { type: "session.output.backfill"; sessionId: string; chunks: RemoteOutputChunk[] };

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
  /**
   * 已配对设备身份证明：未知公钥直接断开。
   * deviceId 仅经 relay 连接时携带（pair_ack 里分配的那个 id）：host 按它把帧分流到
   * 该设备的逻辑连接；局域网直连无需携带。
   */
  | { t: "auth"; publicKey: string; deviceId?: string };

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

/**
 * 配对完成后所有业务流量的信封：c = base64( nonce(24B) ‖ box(JSON(RemoteEncryptedPayload)) )
 *
 * seq 语义：绑定「逻辑连接」而非配对关系——
 * - 局域网：每条 TCP/WS 连接建立时双方 seq 从 0 重新开始；
 * - relay：seq 绑定「设备-relay 连接」。设备重连 relay 后必须重新 auth，
 *   host 收到 auth 即重置该设备的入站 seq 校验（出站 seq 按 deviceId 维度单调递增，
 *   跨 host-relay 断线重连保持不变）；relay 的离线补投帧沿用发送方原始 seq 且按 FIFO 补投，
 *   因此重放校验不会误判。
 */
export interface RemoteEncryptedFrame {
  /** 帧 id（命令帧由发送方生成，响应用同 id 关联） */
  id: string;
  /** 每连接每方向单调递增（从 0 开始），防重放 */
  seq: number;
  t: "encrypted";
  c: string;
  /**
   * relay 路由/过滤元数据（仅经 relay 的帧携带；局域网直连省略）：
   * 多设备共享一条 host↔relay 连接时，发送方在帧外层带上对端 deviceId——
   * device→host 方向 host 按它分流到对应虚拟连接；host→device 方向 relay 为广播
   * 语义，该字段供接收端廉价丢弃他设备帧（隔离由逐设备加密兜底）。
   * 明文元数据，relay 本就能看到等量信息（连接对），不扩大暴露面。
   */
  deviceId?: string;
}

/**
 * relay 管道上的控制帧（relay 服务器产生，业务两端不生成）：
 * - relay.hello：连接建立后 relay 下发，queued = 离线队列补投条数；
 * - relay.error：如 channel_full（同 channel 已有 host 在线）等，记录日志即可。
 */
export type RelayControlFrame =
  | { t: "relay.hello"; role: "host" | "device"; queued: number }
  | { t: "relay.error"; error: string };

export type RemoteWireFrame = RemoteClientHello | RemoteServerHello | RemoteEncryptedFrame | RelayControlFrame;

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

/** 断线补拉的输出 chunk（session.output 的持久化形态） */
export interface RemoteOutputChunk {
  seq: number;
  kind: "text" | "thinking";
  chunk: string;
}

/** 设置项：远程控制开关、监听端口与 relay 地址 */
export interface RemoteSettings {
  enabled: boolean;
  /** 局域网监听端口（null = 随机端口） */
  port: number | null;
  /**
   * relay 服务器地址（wss://host[:port]，不含路径；null = 不启用 relay 通道）。
   * host 侧出站连接 wss://<relayUrl>/channel/<channelId>?role=host，
   * channelId = SHA-256(桌面 X25519 公钥原始 32 字节) 的 hex 小写。
   */
  relayUrl: string | null;
  /**
   * Tailscale 直连（M3，默认 false）：开启且检测到 tailscaled 时，
   * 执行 tailscale serve 把局域网端口映射到 tailnet https 地址
   */
  tailscale: boolean;
  /** Web Push 通知（M2，默认 false）：权限请求 / 提问 / 定时任务触发时推无内容提醒 */
  pushEnabled: boolean;
}

/** 浏览器 PushSubscription 的 JSON 形态（push.subscribe 命令载荷） */
export interface RemotePushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Tailscale 通道状态（RemoteStatus 字段） */
export interface RemoteTailscaleStatus {
  /** 检测到 tailscaled 可用 */
  available: boolean;
  /** 设置开启且 serve 已生效 */
  enabled: boolean;
  /** tailnet https 地址（如 https://my-mac.tail1234.ts.net），未生效为 null */
  url: string | null;
}

/** 当前有效的配对窗口（OTP 单次有效，5 分钟过期） */
export interface RemotePairingInfo {
  otp: string;
  /**
   * QR payload：
   *   spcode-remote://pair?v=1&hosts=<逗号分隔的 base url,URL编码>&desktop_pk=<base64>&otp=<8位数字>
   * 例：spcode-remote://pair?v=1&hosts=http%3A%2F%2F192.168.1.5%3A8123&desktop_pk=…&otp=12345678
   *
   * hosts 前缀约定：普通项为局域网直连 base url（http://ip:port）；
   * 以 `relay+` 开头的项为 relay 通道（如 relay+wss://relay.example.com），
   * 客户端据此区分直连与 relay——relay 项去掉前缀后按
   *   wss://<relay>/channel/<channelId>?role=device 建连，
   * channelId = SHA-256(desktop_pk 解码后的原始 32 字节) 的 hex 小写。
   */
  qrPayload: string;
  expiresAt: number;
  urls: string[];
}

/** relay 通道连接状态：disabled = 未配置 relayUrl / 远程未启用 */
export type RemoteRelayState = "disabled" | "connecting" | "connected";

/** getRemoteStatus IPC 的返回结构 */
export interface RemoteStatus {
  enabled: boolean;
  /** 可访问地址列表（局域网 http://ip:port + relay+wss://… 前缀项 + tailscale https 直连项）；未启动时为空 */
  urls: string[];
  devices: PairedDevice[];
  pairing: RemotePairingInfo | null;
  /** relay 通道连接状态 */
  relay: RemoteRelayState;
  /** Tailscale 通道状态 */
  tailscale: RemoteTailscaleStatus;
}
