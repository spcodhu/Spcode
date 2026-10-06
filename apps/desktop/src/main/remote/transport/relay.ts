/**
 * relay Transport（M2）：harness 作为 host 出站长连接哑 relay，公网可达。
 *
 * 协议（与 apps/relay 服务端对齐）：
 * - 连接：`wss://<relayUrl>/channel/<channelId>?role=host`；
 *   channelId = SHA-256(桌面 X25519 公钥原始 32 字节) 的 hex 小写（见 deriveChannelId）；
 * - 帧：与 LAN 完全相同的 JSON 文本帧（pair/auth/encrypted 原样穿过 relay）；
 *   relay 额外产生 {t:"relay.hello", role, queued}（queued = 离线补投条数，记日志）
 *   与 {t:"relay.error", error}（channel_full 等，记日志即可）；
 * - 断线：指数退避自动重连（默认 1s → 30s）；host 断线期间 device 发的帧由 relay
 *   离线队列按 FIFO 补投，帧沿用发送方原始 seq。
 *
 * 多设备路由（一条 host↔relay 连接承载多台手机）：
 * - 每台设备映射为一条「虚拟 PeerConnection」，按 deviceId 键控，**跨 host-relay
 *   断线重连保持不销毁**——设备的 seq 计数器在其 relay 连接生命周期内连续，
 *   host 侧的入站防重放状态因此也必须连续，补投帧才不会被误判为重放；
 * - device→host：设备在 auth / encrypted 帧外层携带 deviceId（pair 帧除外），
 *   relay 原样转发给 host，host 按 deviceId 分流到对应虚拟连接；
 * - host→device：relay 是**广播语义**（原样发给全部在线设备；无设备在线时入队，
 *   下一设备上线补投）。host 发送时在帧外层附对端 deviceId 作为过滤元数据——
 *   客户端据此廉价丢弃他设备帧；隔离由逐设备加密兜底（他设备帧解不开）；
 * - 无 deviceId 的帧只有 pair_ack 与配对期快照：密文只有配对中的设备能解开；
 * - 设备经 relay 配对成功后必须先再发一帧 auth（带 publicKey + deviceId）再发加密流量：
 *   配对用的临时虚拟连接在 pair_ack ok 后即关闭，业务状态挂在按 deviceId 键控的
 *   正式虚拟连接上，避免同一设备两条逻辑连接导致事件双发、seq 错乱；
 * - host 主动关闭某虚拟连接（重放/解密失败）后，该 deviceId 进入墓碑态：
 *   后续非 hello 帧一律丢弃，直到设备重新 auth 开启新逻辑会话。
 */

import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { b64decode } from "../crypto.js";
import type { PeerConnection, RemoteTransport } from "./types.js";

/** channelId = SHA-256(桌面 X25519 公钥原始 32 字节) 的 hex 小写 */
export function deriveChannelId(desktopPublicKeyB64: string): string {
  return createHash("sha256").update(b64decode(desktopPublicKeyB64)).digest("hex");
}

export interface RelayTransportOptions {
  /** relay 地址（wss://host[:port]，不含路径） */
  url: string;
  /** 见 deriveChannelId */
  channelId: string;
  /** 重连退避（默认 1000ms 起步，翻倍至 30000ms 封顶） */
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  /** 断线期间本地出站缓冲上限（默认 500，超出丢最旧） */
  pendingLimit?: number;
  log?: (msg: string, extra?: unknown) => void;
}

/** 帧路由键：auth 帧缺 deviceId 时退回公钥键（此时 host→device 帧无 deviceId，由 relay 广播兜底） */
function frameRoutingKey(frame: Record<string, unknown>): string | null {
  if (typeof frame.deviceId === "string" && frame.deviceId) return frame.deviceId;
  if (frame.t === "auth" && typeof frame.publicKey === "string") return `pk:${frame.publicKey}`;
  return null;
}

class RelayPeer implements PeerConnection {
  readonly id = randomUUID();
  private readonly msgCbs: ((frame: unknown) => void)[] = [];
  private readonly closeCbs: (() => void)[] = [];
  private closed = false;

  constructor(
    private readonly transport: RelayTransport,
    /** null = 配对临时连接（发送帧不附 deviceId，relay 广播） */
    readonly routingKey: string | null,
  ) {}

  /** 发送时附 deviceId（客户端过滤元数据；pk: 兜底键无 deviceId，帧不带标签由对端解密兜底） */
  send(frame: unknown): void {
    if (this.closed) return;
    const f = frame as Record<string, unknown>;
    const tag =
      this.routingKey && !this.routingKey.startsWith("pk:") && f && typeof f === "object" && !("deviceId" in f)
        ? { deviceId: this.routingKey }
        : null;
    this.transport.sendFrame(tag ? { ...f, ...tag } : frame);
    // 配对临时连接：pair_ack 成功即完成使命（设备随后会带 deviceId 重新 auth），
    // 关掉它避免同一设备两条逻辑连接并存导致广播双发、seq 错乱
    if (this.routingKey === null && f && f.t === "pair_ack" && f.ok === true) {
      queueMicrotask(() => this.transport.retirePairPeer(this));
    }
  }

  deliver(frame: unknown): void {
    if (this.closed) return;
    for (const cb of this.msgCbs) cb(frame);
  }

  onMessage(cb: (frame: unknown) => void): void {
    this.msgCbs.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  /** 逻辑关闭：不关 host↔relay 物理连接，只拆除这条虚拟连接 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.removePeer(this);
    for (const cb of this.closeCbs) cb();
  }

  isClosed(): boolean {
    return this.closed;
  }
}

export class RelayTransport implements RemoteTransport {
  private ws: WebSocket | null = null;
  private connCb: ((peer: PeerConnection) => void) | null = null;
  /** deviceId（或 pk: 兜底键）→ 虚拟连接；跨重连保持 */
  private readonly peers = new Map<string, RelayPeer>();
  /** 被 host 主动关闭的 deviceId：重新 auth 前丢弃其业务帧 */
  private readonly tombstoned = new Set<string>();
  private pairPeer: RelayPeer | null = null;
  private state: "connecting" | "connected" = "connecting";
  private started = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: number;
  private pending: string[] = [];
  private readonly initialDelay: number;
  private readonly maxDelay: number;
  private readonly pendingLimit: number;
  private readonly log: (msg: string, extra?: unknown) => void;

  constructor(private readonly opts: RelayTransportOptions) {
    this.initialDelay = opts.reconnectInitialMs ?? 1000;
    this.maxDelay = opts.reconnectMaxMs ?? 30_000;
    this.pendingLimit = opts.pendingLimit ?? 500;
    this.reconnectDelay = this.initialDelay;
    this.log = opts.log ?? (() => {});
  }

  /** 启动即进入后台连接循环；连接成败不阻塞调用方（设置变更即时返回） */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.state = "connecting";
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      ws.close();
    }
    // 停用时拆除全部虚拟连接（RemoteServer 据此清理对端状态）
    for (const peer of [...this.peers.values()]) peer.close();
    this.peers.clear();
    this.pairPeer?.close();
    this.pairPeer = null;
    this.tombstoned.clear();
    this.pending = [];
  }

  onConnection(cb: (peer: PeerConnection) => void): void {
    this.connCb = cb;
  }

  getState(): "connecting" | "connected" {
    return this.state;
  }

  /** QR hosts 项：`relay+` 前缀约定（客户端据此区分直连与 relay；见 shared/remote.ts） */
  getAdvertisedUrls(): string[] {
    return this.started ? [`relay+${this.opts.url}`] : [];
  }

  /** 虚拟连接发送入口：物化 deviceId 后写入 ws；断线期间进本地缓冲，重连后按序冲刷 */
  sendFrame(frame: unknown): void {
    const text = JSON.stringify(frame);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(text);
      return;
    }
    this.pending.push(text);
    if (this.pending.length > this.pendingLimit) {
      this.pending.splice(0, this.pending.length - this.pendingLimit);
      this.log("relay 出站缓冲超限，丢弃最旧帧", { pendingLimit: this.pendingLimit });
    }
  }

  /** pair_ack ok 后关闭配对临时连接 */
  retirePairPeer(peer: RelayPeer): void {
    if (this.pairPeer === peer) this.pairPeer = null;
    peer.close();
  }

  removePeer(peer: RelayPeer): void {
    if (peer.routingKey) {
      if (this.peers.get(peer.routingKey) === peer) {
        this.peers.delete(peer.routingKey);
        this.tombstoned.add(peer.routingKey);
      }
    } else if (this.pairPeer === peer) {
      this.pairPeer = null;
    }
  }

  // -------------------------------------------------------------------------
  // 连接管理
  // -------------------------------------------------------------------------

  private connect(): void {
    if (!this.started) return;
    const base = this.opts.url.replace(/\/+$/, "");
    const url = `${base}/channel/${this.opts.channelId}?role=host`;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.state = "connecting";

    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.state = "connected";
      this.reconnectDelay = this.initialDelay;
      this.log("relay 已连接", { url: base, channelId: this.opts.channelId });
      // 冲刷断线期间的本地出站缓冲
      const queued = this.pending;
      this.pending = [];
      for (const text of queued) ws.send(text);
    });
    ws.on("message", (data: Buffer) => {
      if (this.ws !== ws) return;
      let frame: unknown;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return; // 非 JSON 帧直接丢弃
      }
      this.route(frame);
    });
    const onDown = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.state = "connecting";
      ws.removeAllListeners();
      this.scheduleReconnect();
    };
    ws.on("close", onDown);
    ws.on("error", (err) => {
      this.log("relay 连接错误", err instanceof Error ? err.message : String(err));
      ws.close();
    });
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxDelay);
    this.log("relay 断线，等待重连", { delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  // -------------------------------------------------------------------------
  // 帧路由
  // -------------------------------------------------------------------------

  private route(frame: unknown): void {
    const f = frame as Record<string, unknown> | null;
    if (!f || typeof f !== "object" || typeof f.t !== "string") return;

    // relay 控制帧：只记日志（queued = 补投条数；channel_full 等 error 不影响业务状态机）
    if (f.t === "relay.hello") {
      this.log("relay.hello", { role: f.role, queued: f.queued });
      return;
    }
    if (f.t === "relay.error") {
      this.log("relay.error", { error: f.error });
      return;
    }

    // 配对帧：无设备身份，走唯一的配对临时虚拟连接
    if (f.t === "pair") {
      if (!this.pairPeer || this.pairPeer.isClosed()) {
        this.pairPeer = this.adopt(null);
      }
      this.pairPeer.deliver(frame);
      return;
    }

    const key = frameRoutingKey(f);
    if (!key) {
      this.log("relay 帧缺路由键，丢弃", { t: f.t });
      return;
    }
    // 重新 auth = 设备侧新连接：清墓碑，重建虚拟连接（入站 seq 由 RemoteServer 在 auth 成功时重置）
    if (f.t === "auth") {
      this.tombstoned.delete(key);
      const existing = this.peers.get(key);
      if (existing && !existing.isClosed()) {
        existing.deliver(frame);
        return;
      }
      this.adopt(key).deliver(frame);
      return;
    }
    if (this.tombstoned.has(key)) return; // 墓碑态：业务帧一律丢弃
    const peer = this.peers.get(key);
    if (peer && !peer.isClosed()) {
      peer.deliver(frame);
      return;
    }
    // 未知的 deviceId 直接发来加密帧（未先 auth）：创建虚拟连接交给 RemoteServer，
    // 首帧不是 hello 会被正常关闭——与 LAN 行为对齐
    this.adopt(key).deliver(frame);
  }

  /** 新建虚拟连接并挂到 RemoteServer */
  private adopt(routingKey: string | null): RelayPeer {
    const peer = new RelayPeer(this, routingKey);
    if (routingKey) this.peers.set(routingKey, peer);
    this.connCb?.(peer);
    return peer;
  }
}
