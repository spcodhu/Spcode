/**
 * RemoteServer：远程控制 M1 的 harness 侧入口。
 *
 * 接线（main/index.ts）：
 *   const remote = new RemoteServer({ settings, bridge, scheduler, registry });
 *   // whenReady 内：await remote.applySettings();（settings.remote.enabled 时启动）
 *
 * 连接安全模型：
 * - WS 首帧必须是 hello：pair（OTP 握手，单次有效）或 auth（已配对设备公钥）；
 *   未知公钥直接断开；
 * - 配对完成后业务帧一律为 {id, seq, t:"encrypted", c}（NaCl box 密文），
 *   seq 每连接每方向单调递增，重放/乱序即断开；
 * - 事件流由 RemoteEventAggregator 把 bridge 的全量 HostEvent 映射为 RemoteEvent，
 *   广播给所有处于 ready 态的连接（逐连接独立加密）。
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
  RemoteStatus,
} from "@spcode/shared";
import { RemoteEventAggregator } from "./aggregator.js";
import { boxDecrypt, boxEncrypt, isValidPublicKey, SeqCounter, SeqGuard } from "./crypto.js";
import { handleRemoteCommand, type RemoteHandlerDeps } from "./handlers.js";
import { PairingManager } from "./pairing.js";
import { LanTransport } from "./transport/lan.js";
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
  /** 测试注入；缺省自动探测 apps/mobile 构建产物 */
  mobileDistDir?: string;
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
  private readonly peers = new Set<PeerState>();
  private transport: RemoteTransport | null;
  private unsubscribeBridge: (() => void) | null = null;
  private running = false;
  /** 当前监听对应的配置端口（用于检测端口变更后重启） */
  private activeConfigPort: number | null = null;

  constructor(deps: RemoteServerDeps) {
    this.deps = deps;
    this.pairing = deps.pairing ?? new PairingManager();
    this.transport = deps.transport ?? null;
    this.aggregator = new RemoteEventAggregator({ emit: (event) => this.broadcast(event) });
  }

  /** 按 settings.remote 启停（设置变更后由 IPC 层显式调用） */
  async applySettings(): Promise<void> {
    const cfg = this.deps.settings.get().remote;
    if (cfg.enabled && (!this.running || this.activeConfigPort !== cfg.port)) {
      await this.stop();
      await this.start();
    } else if (!cfg.enabled && this.running) {
      await this.stop();
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    const cfg = this.deps.settings.get().remote;
    if (!this.transport) {
      this.transport = new LanTransport({
        port: cfg.port ?? 0,
        staticDir: resolveMobileDistDir(this.deps.mobileDistDir),
      });
    }
    this.transport.onConnection((peer) => this.acceptPeer(peer));
    await this.transport.start();
    this.activeConfigPort = cfg.port;
    this.unsubscribeBridge = this.deps.bridge.onEvent((event) => this.aggregator.handle(event));
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = null;
    this.aggregator.dispose();
    for (const state of this.peers) state.peer.close();
    this.peers.clear();
    if (!this.deps.transport) {
      // 自建 transport：停掉以便下次用新端口重建；注入的 transport 由调用方管理
      const t = this.transport;
      this.transport = null;
      await t?.stop();
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  urls(): string[] {
    return this.running && this.transport ? this.transport.getAdvertisedUrls() : [];
  }

  status(): RemoteStatus {
    const cfg = this.deps.settings.get().remote;
    return {
      enabled: cfg.enabled,
      urls: this.urls(),
      devices: this.pairing.devices(),
      pairing: this.currentPairingInfo(),
    };
  }

  /** 重新生成 OTP 并返回 QR payload（设置页「刷新二维码」） */
  regeneratePairing(): RemotePairingInfo {
    const win = this.pairing.beginPairing();
    const urls = this.urls();
    return { otp: win.otp, expiresAt: win.expiresAt, qrPayload: this.pairing.buildQrPayload(urls, win), urls };
  }

  /** 吊销设备：落盘删除 + 断开该设备的现存连接 */
  unpairDevice(deviceId: string): boolean {
    const ok = this.pairing.removeDevice(deviceId);
    if (ok) {
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
      this.sendSnapshot(state);
      return;
    }

    if (hello.t === "auth" && isValidPublicKey(hello.publicKey)) {
      const device = this.pairing.findByPublicKey(hello.publicKey);
      if (!device) {
        state.peer.send({ t: "auth_ack", ok: false, error: "unknown_device" });
        state.peer.close();
        return;
      }
      state.device = device;
      state.inGuard.reset();
      state.peer.send({ t: "auth_ack", ok: true, desktopPk: this.pairing.getIdentity().publicKey });
      this.sendSnapshot(state);
      return;
    }

    state.peer.close(); // 首帧必须是合法 hello
  }

  private async executeCommand(state: PeerState, frameId: string, command: RemoteCommand): Promise<void> {
    let response: RemoteEncryptedPayload;
    try {
      const data = await handleRemoteCommand(command, this.deps);
      response = { kind: "response", id: frameId, ok: true, data };
    } catch (err) {
      response = { kind: "response", id: frameId, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    this.sendEncrypted(state, response);
  }

  private sendSnapshot(state: PeerState): void {
    this.sendEncrypted(state, {
      kind: "event",
      event: { type: "session.snapshot", sessions: this.deps.registry.list() },
    });
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
