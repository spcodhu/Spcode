/**
 * RemoteServer：远程控制的 harness 侧入口（M1 局域网 + M2 relay/Web Push + M3 Tailscale/双端撤卡）。
 *
 * 接线（main/index.ts）：
 *   const remote = new RemoteServer({ settings, bridge, scheduler, registry });
 *   // whenReady 内：await remote.applySettings();（settings.remote.enabled 时启动）
 *
 * 连接安全模型：
 * - WS 首帧必须是 hello：pair（OTP 握手，单次有效）或 auth（已配对设备公钥）；
 *   未知公钥直接断开；
 * - 配对完成后业务帧一律为 {id, seq, t:"encrypted", c}（NaCl box 密文），
 *   seq 绑定逻辑连接（LAN = 每条 TCP 连接；relay = 每设备虚拟连接，重 auth 重置入站），
 *   重放/乱序即断开；
 * - 事件流由 RemoteEventAggregator 把 bridge 的全量 HostEvent 映射为 RemoteEvent，
 *   广播给所有处于 ready 态的连接（逐连接独立加密）；
 *   session.output 同时写入 SessionOutputLog 环形缓冲，供断线补拉（session.output.since）。
 *
 * Transport：局域网（LanTransport，HTTP+WS 同端口）恒随 enabled 启停；
 * settings.remote.relayUrl 非空时额外启动 RelayTransport（出站 wss + 指数退避重连）。
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HostEvent,
  PairedDevice,
  PairAckInner,
  RemoteClientHello,
  RemoteCommand,
  RemoteEncryptedFrame,
  RemoteEncryptedPayload,
  RemoteEvent,
  RemotePairingInfo,
  RemoteRelayState,
  RemoteStatus,
} from "@spcode/shared";
import { RemoteEventAggregator } from "./aggregator.js";
import { boxDecrypt, boxEncrypt, isValidPublicKey, SeqCounter, SeqGuard } from "./crypto.js";
import { handleRemoteCommand, type RemoteHandlerDeps } from "./handlers.js";
import { SessionOutputLog } from "./output-log.js";
import { PairingManager } from "./pairing.js";
import { PushService } from "./push.js";
import { LanTransport } from "./transport/lan.js";
import { deriveChannelId, RelayTransport } from "./transport/relay.js";
import { TailscaleManager } from "./transport/tailscale.js";
import type { PeerConnection, RemoteTransport } from "./transport/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 事件订阅能力（AgentBridge.onEvent 的结构子集） */
export interface BridgeEventSource {
  onEvent(cb: (event: HostEvent) => void): () => void;
}

export interface RemoteServerDeps extends RemoteHandlerDeps {
  bridge: RemoteHandlerDeps["bridge"] & BridgeEventSource;
  /** 测试注入；缺省 ~/.spcode/remote */
  pairing?: PairingManager;
  /** 测试注入；缺省按设置创建 LanTransport */
  transport?: RemoteTransport;
  /** 测试注入；缺省在 relayUrl 非空时创建 RelayTransport（null = 强制不启用 relay） */
  relayTransport?: RemoteTransport | null;
  /** 测试注入；缺省自动探测 apps/mobile 构建产物 */
  mobileDistDir?: string;
  /** 测试注入；缺省 ~/.spcode/remote 下的 VAPID/订阅存储 */
  push?: PushService;
  /** 测试注入；缺省真实 tailscale CLI 检测 */
  tailscale?: TailscaleManager;
}

/** relayUrl 归一化：空白串按未配置处理 */
function normalizeRelayUrl(url: string | null | undefined): string | null {
  const trimmed = typeof url === "string" ? url.trim() : "";
  return trimmed || null;
}

interface PeerState {
  peer: PeerConnection;
  device: PairedDevice | null;
  inGuard: SeqGuard;
  outSeq: SeqCounter;
}

/** PWA 构建产物目录探测：env 覆盖 > 打包 resources > monorepo apps/mobile/dist */
function resolveMobileDistDir(override?: string): string {
  if (override) return override;
  const fromEnv = process.env.SPCODE_MOBILE_DIST?.trim();
  if (fromEnv) return fromEnv;
  const candidates = [
    join(process.resourcesPath ?? "", "mobile"),
    join(__dirname, "../../mobile/dist"),
    join(__dirname, "../../../mobile/dist"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[1]!;
}

export class RemoteServer {
  private readonly deps: RemoteServerDeps;
  private readonly pairing: PairingManager;
  private readonly aggregator: RemoteEventAggregator;
  private readonly outputLog: SessionOutputLog;
  private readonly push: PushService;
  private readonly tailscale: TailscaleManager;
  private readonly peers = new Set<PeerState>();
  private lanTransport: RemoteTransport | null;
  private relayTransport: RemoteTransport | null = null;
  private unsubscribeBridge: (() => void) | null = null;
  private running = false;
  /** 当前运行对应的配置指纹（端口 / relayUrl 变更后重启） */
  private activeConfigPort: number | null = null;
  private activeRelayUrl: string | null = null;
  /** tailscale serve 当前映射的 LAN 端口（0 = 未映射），避免重复执行 serve 命令 */
  private tailscaleServingPort = 0;

  constructor(deps: RemoteServerDeps) {
    this.deps = deps;
    this.pairing = deps.pairing ?? new PairingManager();
    this.lanTransport = deps.transport ?? null;
    this.relayTransport = deps.relayTransport ?? null;
    this.outputLog = new SessionOutputLog();
    this.aggregator = new RemoteEventAggregator({ emit: (event) => this.emitRemote(event) });
    this.push = deps.push ?? new PushService();
    this.tailscale =
      deps.tailscale ??
      new TailscaleManager({ log: (msg, extra) => console.warn(`[remote/tailscale] ${msg}`, extra ?? "") });
  }

  /** 按 settings.remote 启停（设置变更后由 IPC 层显式调用） */
  async applySettings(): Promise<void> {
    const cfg = this.deps.settings.get().remote;
    const relayUrl = normalizeRelayUrl(cfg.relayUrl);
    if (cfg.enabled && (!this.running || this.activeConfigPort !== cfg.port || this.activeRelayUrl !== relayUrl)) {
      await this.stop();
      await this.start();
    } else if (!cfg.enabled && this.running) {
      await this.stop();
    }
    // tailscale 开关独立同步（映射的是 LAN 端口，无需重启整个服务）
    await this.syncTailscale();
  }

  /** 设置页 status 查询前刷新 tailscale 检测（15s 缓存，不频繁 spawn） */
  async refreshTailscaleDetection(): Promise<void> {
    await this.tailscale.detect();
  }

  async start(): Promise<void> {
    if (this.running) return;
    const cfg = this.deps.settings.get().remote;
    const relayUrl = normalizeRelayUrl(cfg.relayUrl);
    if (!this.lanTransport) {
      this.lanTransport = new LanTransport({
        port: cfg.port ?? 0,
        staticDir: resolveMobileDistDir(this.deps.mobileDistDir),
      });
    }
    if (relayUrl && !this.relayTransport) {
      this.relayTransport = new RelayTransport({
        url: relayUrl,
        channelId: deriveChannelId(this.pairing.getIdentity().publicKey),
        log: (msg, extra) => console.warn(`[remote/relay] ${msg}`, extra ?? ""),
      });
    }
    // relayUrl 被清空：停掉自建的 relay transport（注入的由调用方管理）
    if (!relayUrl && this.relayTransport && this.deps.relayTransport === undefined) {
      const t = this.relayTransport;
      this.relayTransport = null;
      await t.stop();
    }
    const transports = [this.lanTransport, ...(relayUrl && this.relayTransport ? [this.relayTransport] : [])];
    for (const t of transports) {
      t.onConnection((peer) => this.acceptPeer(peer));
      await t.start();
    }
    this.activeConfigPort = cfg.port;
    this.activeRelayUrl = relayUrl;
    // 首次启用即生成 VAPID 密钥对（remote.hello 携带公钥供设备订阅推送）
    this.push.ensureVapid();
    this.unsubscribeBridge = this.deps.bridge.onEvent((event) => {
      this.aggregator.handle(event);
      // Web Push 触发点（M2）：无内容提醒；设置关闭或失败都不影响主流程
      void this.push
        .notifyForHostEvent(event, this.deps.settings.get().remote.pushEnabled === true)
        .catch((err) => console.warn("[remote/push] 推送异常", err));
    });
    this.running = true;
    // tailscale serve 依赖 LAN 已起（需要实际端口）
    await this.syncTailscale();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = null;
    this.aggregator.dispose();
    for (const state of this.peers) state.peer.close();
    this.peers.clear();
    // 撤销 tailscale serve 映射（只在我们开启过时执行 off）
    this.tailscaleServingPort = 0;
    await this.tailscale.disable();
    // 自建 transport：停掉以便下次用新配置重建；注入的 transport 由调用方管理
    if (!this.deps.transport) {
      const t = this.lanTransport;
      this.lanTransport = null;
      await t?.stop();
    }
    if (this.relayTransport && this.deps.relayTransport === undefined) {
      const t = this.relayTransport;
      this.relayTransport = null;
      await t.stop();
    }
  }

  /**
   * tailscale serve 映射同步：开启且运行中 → 映射到当前 LAN 端口（幂等，同端口跳过）；
   * 其余情况 → 撤销映射。tailscale 不可用 / 命令失败只记日志，不影响主流程。
   */
  private async syncTailscale(): Promise<void> {
    const cfg = this.deps.settings.get().remote;
    if (this.running && cfg.tailscale === true) {
      const port = this.lanTransport?.getPort?.() ?? 0;
      if (port <= 0) return;
      if (this.tailscaleServingPort === port && this.tailscale.status().enabled) return;
      const url = await this.tailscale.enable(port);
      this.tailscaleServingPort = url ? port : 0;
      return;
    }
    if (this.tailscaleServingPort !== 0 || this.tailscale.status().enabled) {
      this.tailscaleServingPort = 0;
      await this.tailscale.disable();
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  urls(): string[] {
    if (!this.running) return [];
    const urls: string[] = [];
    if (this.lanTransport) urls.push(...this.lanTransport.getAdvertisedUrls());
    if (this.activeRelayUrl && this.relayTransport) urls.push(...this.relayTransport.getAdvertisedUrls());
    // tailscale 直连项：https://<magicdns>（QR hosts 的普通直连项约定，客户端按 base url 直连）
    const ts = this.tailscale.status();
    if (ts.enabled && ts.url) urls.push(ts.url);
    return urls;
  }

  relayState(): RemoteRelayState {
    if (!this.activeRelayUrl || !this.relayTransport || !this.running) return "disabled";
    return this.relayTransport.getState?.() ?? "connecting";
  }

  status(): RemoteStatus {
    const cfg = this.deps.settings.get().remote;
    return {
      enabled: cfg.enabled,
      urls: this.urls(),
      devices: this.pairing.devices(),
      pairing: this.currentPairingInfo(),
      relay: this.relayState(),
      tailscale: this.tailscale.status(),
    };
  }

  /** 重新生成 OTP 并返回 QR payload（设置页「刷新二维码」） */
  regeneratePairing(): RemotePairingInfo {
    const win = this.pairing.beginPairing();
    const urls = this.urls();
    return { otp: win.otp, expiresAt: win.expiresAt, qrPayload: this.pairing.buildQrPayload(urls, win), urls };
  }

  /** 吊销设备：落盘删除 + 断开该设备的现存连接 + 删除其推送订阅 */
  unpairDevice(deviceId: string): boolean {
    const ok = this.pairing.removeDevice(deviceId);
    if (ok) {
      this.push.unsubscribeDevice(deviceId);
      for (const state of this.peers) {
        if (state.device?.id === deviceId) state.peer.close();
      }
    }
    return ok;
  }

  private currentPairingInfo(): RemotePairingInfo | null {
    const win = this.pairing.currentPairing();
    if (!win) return null;
    const urls = this.urls();
    return { otp: win.otp, expiresAt: win.expiresAt, qrPayload: this.pairing.buildQrPayload(urls, win), urls };
  }

  // -------------------------------------------------------------------------
  // 连接生命周期
  // -------------------------------------------------------------------------

  private acceptPeer(peer: PeerConnection): void {
    const state: PeerState = { peer, device: null, inGuard: new SeqGuard(), outSeq: new SeqCounter() };
    this.peers.add(state);
    peer.onMessage((frame) => this.handleFrame(state, frame));
    peer.onClose(() => this.peers.delete(state));
  }

  private handleFrame(state: PeerState, frame: unknown): void {
    if (!state.device) {
      this.handleHello(state, frame);
      return;
    }
    // relay 场景：设备重连后会在原逻辑连接上重新 auth（= 新设备连接，入站 seq 归零），
    // 握手帧任何时候都走 hello 分支；hello 内做同公钥校验，身份切换直接断开
    const maybeHello = frame as { t?: string } | null;
    if (maybeHello && (maybeHello.t === "pair" || maybeHello.t === "auth")) {
      this.handleHello(state, frame);
      return;
    }
    const f = frame as RemoteEncryptedFrame | null;
    if (!f || f.t !== "encrypted" || typeof f.id !== "string" || typeof f.c !== "string") {
      state.peer.close();
      return;
    }
    if (!state.inGuard.accept(f.seq)) {
      state.peer.close(); // 重放 / 乱序：直接断开
      return;
    }
    const plain = boxDecrypt(f.c, state.device.publicKey, this.pairing.getIdentity().secretKey);
    if (!plain) {
      state.peer.close(); // 解密失败（篡改 / 密钥错配）：直接断开
      return;
    }
    let payload: RemoteEncryptedPayload;
    try {
      payload = JSON.parse(plain) as RemoteEncryptedPayload;
    } catch {
      return;
    }
    if (payload.kind !== "command") return;
    void this.executeCommand(state, f.id, payload.command);
  }

  private handleHello(state: PeerState, frame: unknown): void {
    const hello = frame as RemoteClientHello | null;
    if (!hello || typeof hello !== "object") {
      state.peer.close();
      return;
    }

    if (hello.t === "pair" && typeof hello.otp === "string" && typeof hello.c === "string") {
      const result = this.pairing.tryPair(hello.otp, hello.c);
      if (!result.ok) {
        state.peer.send({ t: "pair_ack", ok: false, error: result.error });
        return; // 未锁定时允许在同一连接上重试
      }
      state.device = result.device;
      state.inGuard.reset();
      const inner: PairAckInner = {
        desktopPk: this.pairing.getIdentity().publicKey,
        deviceId: result.device.id,
      };
      const c = boxEncrypt(JSON.stringify(inner), result.device.publicKey, this.pairing.getIdentity().secretKey);
      state.peer.send({ t: "pair_ack", ok: true, c });
      // 先快照后 remote.hello：保持「首个加密帧 = session.snapshot」的既有协议顺序
      this.sendSnapshot(state);
      this.sendHello(state);
      return;
    }

    if (hello.t === "auth" && isValidPublicKey(hello.publicKey)) {
      const device = this.pairing.findByPublicKey(hello.publicKey);
      if (!device) {
        state.peer.send({ t: "auth_ack", ok: false, error: "unknown_device" });
        state.peer.close();
        return;
      }
      // 已绑定的逻辑连接不允许中途换设备身份（防串号）
      if (state.device && state.device.publicKey !== hello.publicKey) {
        state.peer.close();
        return;
      }
      // 重新 auth = 对端新连接：入站 seq 归零重新校验；出站 seq 保持单调（relay 离线
      // 队列里可能还有高 seq 的在途帧，归零会让对端把新帧误判为重放）
      state.device = device;
      state.inGuard.reset();
      state.peer.send({ t: "auth_ack", ok: true, desktopPk: this.pairing.getIdentity().publicKey });
      this.sendSnapshot(state);
      this.sendHello(state);
      return;
    }

    state.peer.close(); // 首帧必须是合法 hello
  }

  private async executeCommand(state: PeerState, frameId: string, command: RemoteCommand): Promise<void> {
    // 断线补拉：结果以 session.output.backfill 事件下发（按 seq 升序，只含 > afterSeq 的）
    if (command.type === "session.output.since") {
      const chunks = this.outputLog.since(command.sessionId, command.afterSeq);
      this.sendEncrypted(state, {
        kind: "event",
        event: { type: "session.output.backfill", sessionId: command.sessionId, chunks },
      });
      this.sendEncrypted(state, { kind: "response", id: frameId, ok: true, data: { count: chunks.length } });
      return;
    }
    // Web Push 订阅登记（M2）：按 deviceId 存储；订阅 JSON 不合法时响应 ok:false
    if (command.type === "push.subscribe") {
      let response: RemoteEncryptedPayload;
      try {
        this.push.subscribe(state.device!.id, command.subscription);
        response = { kind: "response", id: frameId, ok: true, data: { ok: true } };
      } catch (err) {
        response = { kind: "response", id: frameId, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      this.sendEncrypted(state, response);
      return;
    }
    let response: RemoteEncryptedPayload;
    try {
      const data = await handleRemoteCommand(command, this.deps);
      if (command.type === "session.remove") this.outputLog.drop(command.sessionId);
      response = { kind: "response", id: frameId, ok: true, data };
    } catch (err) {
      response = { kind: "response", id: frameId, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    this.sendEncrypted(state, response);
  }

  /** auth / pair 成功后的首个事件：VAPID 公钥（设备据此订阅 Web Push） */
  private sendHello(state: PeerState): void {
    this.sendEncrypted(state, {
      kind: "event",
      event: { type: "remote.hello", vapidPublicKey: this.push.vapidPublicKey() },
    });
  }

  private sendSnapshot(state: PeerState): void {
    this.sendEncrypted(state, {
      kind: "event",
      event: { type: "session.snapshot", sessions: this.deps.registry.list() },
    });
  }

  /** 聚合器出口：session.output 先落补拉环形缓冲再广播 */
  private emitRemote(event: RemoteEvent): void {
    if (event.type === "session.output") {
      this.outputLog.append(event.sessionId, { seq: event.seq, kind: event.kind ?? "text", chunk: event.chunk });
    }
    this.broadcast(event);
  }

  private broadcast(event: RemoteEvent): void {
    for (const state of this.peers) {
      if (state.device) this.sendEncrypted(state, { kind: "event", event });
    }
  }

  private sendEncrypted(state: PeerState, payload: RemoteEncryptedPayload): void {
    if (!state.device) return;
    const frame: RemoteEncryptedFrame = {
      id: randomUUID(),
      seq: state.outSeq.take(),
      t: "encrypted",
      c: boxEncrypt(JSON.stringify(payload), state.device.publicKey, this.pairing.getIdentity().secretKey),
    };
    state.peer.send(frame);
  }
}
