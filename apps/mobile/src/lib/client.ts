/**
 * RemoteClient：手机侧 WS 协议客户端（配对 / 重连 / 加密帧收发）。
 *
 * 与桌面端 RemoteServer 的契约（packages/shared/src/remote.ts）：
 * - 首帧明文：pair（OTP secretbox）或 auth（已配对公钥）；
 * - 之后全部 {id, seq, t:"encrypted", c}，seq 每连接每方向 0 起严格递增；
 * - 乱序 / 重放 / 解密失败 → 本端主动断开（与桌面行为一致）；
 * - command 帧带自增唯一 id，响应用同 id 关联。
 *
 * 环境要求：全局 WebSocket（浏览器 / Node ≥ 22 均有）；tweetnacl 的随机数
 * 依赖 crypto.getRandomValues（非安全上下文也可用）。
 */

import type { RemoteCommand, RemoteEncryptedFrame, RemoteEncryptedPayload } from "@spcode/shared";
import { generateKeyPair, openPayload, pairOpen, pairSeal, SeqCounter, SeqGuard, sealPayload } from "./crypto";
import type { PairingRecord } from "./db";
import type { RemoteCommandExt, RemoteEventExt } from "./protocol";
import { parseQrPayload } from "./qr";
import { isRelayHost, orderHosts, relayWsUrl } from "./relay";

export type PairErrorCode = "locked" | "expired" | "otp_mismatch" | "bad_payload";

export class PairError extends Error {
  constructor(
    readonly code: PairErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PairError";
  }
}

export const PAIR_ERROR_TEXT: Record<PairErrorCode, string> = {
  locked: "配对已锁定（错误次数过多），请稍后在桌面端重新生成配对码",
  expired: "配对码已过期，请在桌面端重新生成",
  otp_mismatch: "配对码不正确或已被使用，请在桌面端重新生成",
  bad_payload: "配对数据损坏，请重试",
};

/** 帧 id：非安全上下文下 crypto.randomUUID 不可用，用计数器 + getRandomValues 随机段 */
let idCounter = 0;
function genFrameId(): string {
  const rand = new Uint8Array(6);
  globalThis.crypto?.getRandomValues?.(rand);
  const hex = [...rand].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `m${Date.now().toString(36)}-${(idCounter++).toString(36)}-${hex}`;
}

function wsUrlOf(host: string): string {
  return `${host.replace(/^http/, "ws").replace(/\/+$/, "")}/ws`;
}

/** host 项 → 实际 ws url：relay 前缀项走 channel 路径，其余为 LAN 直连 */
function connectUrlOf(host: string, desktopPk: string): string {
  return isRelayHost(host) ? relayWsUrl(host, desktopPk) : wsUrlOf(host);
}

/** 等一帧满足条件的消息；超时或断连即 reject */
function waitFrame(
  ws: WebSocket,
  pred: (frame: unknown) => boolean,
  timeoutMs: number,
  what: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${what}超时`));
    }, timeoutMs);
    const onMessage = (ev: MessageEvent) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (pred(frame)) {
        cleanup();
        resolve(frame);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`${what}前连接已断开`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
  });
}

/** 建立 WS 连接（带超时），成功返回 OPEN 态的 ws */
function connectWs(url: string, timeoutMs = 6000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error("连接超时"));
    }, timeoutMs);
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("无法连接到桌面端"));
    });
  });
}

/**
 * 一次性配对流程：解析 QR payload → 逐个 host 尝试 pair 握手 → 返回可持久化的 PairingRecord。
 * OTP 单次有效且错误计数共享，收到确定性的 pair_ack（无论成败）后不再尝试其余 host。
 */
/**
 * 一次性配对流程：解析 QR payload → 逐个 host 尝试 pair 握手 → 返回可持久化的 PairingRecord。
 * OTP 单次有效且错误计数共享，收到确定性的 pair_ack（无论成败）后不再尝试其余 host。
 *
 * relay 注意：pair 帧不带 deviceId（此时尚未分配）；pair_ack ok 后桌面即关闭配对用的
 * 逻辑连接——本函数随后关掉物理连接，业务流量由 RemoteClient 重新连接并先走 auth
 * （带 deviceId）再发加密帧，符合 relay 契约。
 */
export async function pairWithQr(qrText: string, deviceName: string): Promise<PairingRecord> {
  const payload = parseQrPayload(qrText);
  const keyPair = generateKeyPair();
  const c = pairSeal({ publicKey: keyPair.publicKey, name: deviceName }, payload.otp);

  let lastError: Error | null = null;
  for (const host of orderHosts(payload.hosts)) {
    let ws: WebSocket | null = null;
    try {
      ws = await connectWs(connectUrlOf(host, payload.desktopPk));
      // 协议 v2：OTP 不上线，桌面用当前配对窗口 OTP 试解密文验证
      ws.send(JSON.stringify({ t: "pair", c }));
      const ack = (await waitFrame(ws, (f) => (f as { t?: string }).t === "pair_ack", 8000, "等待配对应答")) as
        | { t: "pair_ack"; ok: true; c: string }
        | { t: "pair_ack"; ok: false; error: string };
      ws.close();
      if (!ack.ok) {
        throw new PairError(
          (ack.error as PairErrorCode) in PAIR_ERROR_TEXT ? (ack.error as PairErrorCode) : "bad_payload",
          PAIR_ERROR_TEXT[
            (ack.error as PairErrorCode) in PAIR_ERROR_TEXT ? (ack.error as PairErrorCode) : "bad_payload"
          ],
        );
      }
      const inner = pairOpen(ack.c, payload.desktopPk, keyPair.secretKey);
      if (!inner) throw new PairError("bad_payload", PAIR_ERROR_TEXT.bad_payload);
      if (inner.desktopPk !== payload.desktopPk) {
        throw new PairError("bad_payload", "应答中的桌面公钥与配对码不一致，已中止（可能遭遇中间人攻击）");
      }
      return {
        version: 1,
        desktopPk: inner.desktopPk,
        deviceId: inner.deviceId,
        hosts: payload.hosts,
        deviceName,
        keyPair,
        pairedAt: Date.now(),
      };
    } catch (err) {
      ws?.close();
      if (err instanceof PairError) throw err; // 确定性失败：OTP 已消耗，不再换 host
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error("所有桌面地址均无法连接");
}

// ---------------------------------------------------------------------------
// 长连接客户端（auth 模式 + 自动重连）
// ---------------------------------------------------------------------------

export type ConnectionState =
  | "connecting" // 首次连接 / 握手中
  | "ready" // 已认证，可收发
  | "reconnecting" // 断线，退避重连中
  | "unpaired" // 桌面端不认识本设备（已在桌面侧解除配对）→ 需重新扫码
  | "stopped";

export interface RemoteClientCallbacks {
  onEvent(event: RemoteEventExt): void;
  onState(state: ConnectionState, detail?: string): void;
}

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const COMMAND_TIMEOUT_MS = 30_000;

export interface RemoteClientOptions {
  /** 测试用：覆盖重连退避起步值 */
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

export class RemoteClient {
  private ws: WebSocket | null = null;
  private state: ConnectionState = "stopped";
  private stopped = true;
  private backoff: number;
  private readonly backoffMin: number;
  private readonly backoffMax: number;
  private hostIndex = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 连接尝试顺序：LAN 直连优先，relay 殿后（构造时固化） */
  private readonly hosts: string[];
  /** 当前连接是否 relay 通道（决定 deviceId 帧外层封装/过滤与解密失败语义） */
  private relay = false;

  private readonly outSeq = new SeqCounter();
  private readonly inSeq = new SeqGuard();
  private readonly pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  /**
   * 握手完成前到达的加密帧缓冲：auth_ack 与紧随其后的 snapshot 可能落在同一 TCP 段里，
   * 被同一轮事件循环同步派发——此时状态还没翻成 ready，直接丢会丢快照（真实发生过）。
   */
  private earlyFrames: unknown[] = [];

  constructor(
    private readonly record: PairingRecord,
    private readonly cb: RemoteClientCallbacks,
    opts: RemoteClientOptions = {},
  ) {
    this.hosts = orderHosts(record.hosts);
    this.backoffMin = opts.backoffMinMs ?? BACKOFF_MIN_MS;
    this.backoffMax = opts.backoffMaxMs ?? BACKOFF_MAX_MS;
    this.backoff = this.backoffMin;
  }

  getState(): ConnectionState {
    return this.state;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.backoff = this.backoffMin;
    void this.connectOnce();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.setState("stopped");
    this.failAllPending(new Error("客户端已停止"));
    this.ws?.close();
    this.ws = null;
  }

  /** 发送加密命令并等待同 id 响应；非 ready 态立即失败 */
  command<T = unknown>(cmd: RemoteCommandExt, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    const ws = this.ws;
    if (this.state !== "ready" || !ws) {
      return Promise.reject(new Error("未连接到桌面端"));
    }
    const id = genFrameId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("命令响应超时"));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
      // RemoteCommandExt 含尚未收敛进 shared 的命令（见 protocol.ts），线上帧格式一致
      this.sendEncrypted(ws, id, { kind: "command", command: cmd as RemoteCommand });
    });
  }

  private setState(state: ConnectionState, detail?: string): void {
    this.state = state;
    this.cb.onState(state, detail);
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped) return;
    this.setState(this.state === "reconnecting" ? "reconnecting" : "connecting");
    const host = this.hosts[this.hostIndex % this.hosts.length]!;
    this.hostIndex++;
    this.relay = isRelayHost(host);
    let ws: WebSocket;
    try {
      ws = await connectWs(connectUrlOf(host, this.record.desktopPk));
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : "连接失败");
      return;
    }
    this.ws = ws;

    ws.addEventListener("message", (ev) => this.onRawMessage(ws, ev));
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.ws = null;
      this.failAllPending(new Error("连接已断开"));
      if (!this.stopped && this.state !== "unpaired") this.scheduleReconnect("连接已断开");
    });
    ws.addEventListener("error", () => ws.close());

    // auth 握手：每连接重置双向 seq 与早到帧缓冲。
    // 桌面侧 relay 出站 seq 跨重连不归零（离线队列里可能有高 seq 在途帧），
    // 但 SeqGuard 重置后接受任意首个合法 seq、随后严格递增，两种语义都兼容。
    this.outSeq.reset();
    this.inSeq.reset();
    this.earlyFrames = [];
    try {
      // relay 是广播语义：auth 帧外层带 deviceId，host 据此把帧分流到本设备的虚拟连接
      const hello: { t: "auth"; publicKey: string; deviceId?: string } = {
        t: "auth",
        publicKey: this.record.keyPair.publicKey,
      };
      if (this.relay) hello.deviceId = this.record.deviceId;
      ws.send(JSON.stringify(hello));
      const ack = (await waitFrame(
        ws,
        (f) => {
          const frame = f as { t?: string; deviceId?: string };
          // relay 广播下可能收到他设备的 auth_ack：带 deviceId 且不匹配的不是给我们的
          if (frame.t !== "auth_ack") return false;
          return !this.relay || typeof frame.deviceId !== "string" || frame.deviceId === this.record.deviceId;
        },
        8000,
        "等待认证应答",
      )) as {
        t: "auth_ack";
        ok: boolean;
        desktopPk?: string;
      };
      if (!ack.ok) {
        this.stopped = true; // 桌面已不认识本设备：不再自动重连，等待用户重新配对
        this.setState("unpaired");
        ws.close();
        return;
      }
      if (ack.desktopPk && ack.desktopPk !== this.record.desktopPk) {
        // 桌面换了身份密钥（重装/重置）：旧配对全部作废
        this.stopped = true;
        this.setState("unpaired", "桌面端身份已变更，请重新配对");
        ws.close();
        return;
      }
      this.backoff = this.backoffMin;
      this.setState("ready");
      // 冲刷握手期间（同一轮事件循环里）先到的加密帧（典型：snapshot 紧随 auth_ack）
      const early = this.earlyFrames;
      this.earlyFrames = [];
      for (const frame of early) this.onEncryptedFrame(ws, frame);
    } catch (err) {
      ws.close();
      if (!this.stopped) this.scheduleReconnect(err instanceof Error ? err.message : "认证失败");
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer) return;
    this.setState("reconnecting", reason);
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.backoffMax);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectOnce();
    }, delay);
  }

  private onRawMessage(ws: WebSocket, ev: MessageEvent): void {
    if (ws !== this.ws) return;
    let frame: unknown;
    try {
      frame = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const f = frame as { t?: unknown; c?: unknown; id?: unknown; deviceId?: unknown };
    // relay 控制帧（relay.hello / relay.error）：只与通道有关，业务层忽略
    if (f.t === "relay.hello" || f.t === "relay.error") return;
    // relay 广播语义：带 deviceId 且不是本设备的帧廉价丢弃（隔离由逐设备加密兜底）
    if (this.relay && typeof f.deviceId === "string" && f.deviceId !== this.record.deviceId) return;
    if (f.t !== "encrypted" || typeof f.c !== "string" || typeof f.id !== "string") return;
    if (this.state !== "ready") {
      // 握手阶段的消息由 waitFrame 处理；紧随 ack 到达的加密帧先缓冲，ready 后按序冲刷
      this.earlyFrames.push(frame);
      return;
    }
    this.onEncryptedFrame(ws, frame);
  }

  private onEncryptedFrame(ws: WebSocket, frame: unknown): void {
    const f = frame as Partial<RemoteEncryptedFrame>;
    if (typeof f.c !== "string") return;

    // 先解密鉴帧再动 seq 防重放：relay 广播下无 deviceId 的他设备残留帧（pair 期帧等）
    // 解不开直接丢弃，不能让它推进/触发本设备的 SeqGuard。
    const payload = openPayload(f.c, this.record.desktopPk, this.record.keyPair.secretKey);
    if (!payload) {
      // LAN 直连不存在串线，解密失败即篡改/密钥错配，主动断开（与桌面行为一致）
      if (this.relay) return;
      ws.close();
      return;
    }
    // 防重放：seq 必须严格递增；乱序 → 主动断开（桌面同款策略）
    if (!this.inSeq.accept(f.seq)) {
      ws.close();
      return;
    }
    this.routePayload(payload);
  }

  private routePayload(payload: RemoteEncryptedPayload): void {
    if (payload.kind === "event") {
      this.cb.onEvent(payload.event);
      return;
    }
    if (payload.kind === "response") {
      const entry = this.pending.get(payload.id);
      if (!entry) return;
      this.pending.delete(payload.id);
      clearTimeout(entry.timer);
      if (payload.ok) entry.resolve(payload.data);
      else entry.reject(new Error(payload.error ?? "命令执行失败"));
    }
  }

  private sendEncrypted(ws: WebSocket, id: string, payload: RemoteEncryptedPayload): void {
    const frame: RemoteEncryptedFrame = {
      id,
      seq: this.outSeq.take(),
      t: "encrypted",
      c: sealPayload(payload, this.record.desktopPk, this.record.keyPair.secretKey),
    };
    // relay 广播语义：帧外层带 deviceId，host 据此分流到本设备的虚拟连接
    if (this.relay) frame.deviceId = this.record.deviceId;
    ws.send(JSON.stringify(frame));
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}
