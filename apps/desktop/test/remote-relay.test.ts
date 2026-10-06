/**
 * relay Transport + RemoteServer 集成测试：进程内假 relay（ws 服务器，
 * 按 M2 协议转发/离线队列）跑通——
 * 配对经 relay、加密命令往返、断线期间队列补投、多设备隔离、
 * 断线补拉（session.output.since/backfill）、seq 绑定逻辑连接的语义。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type HostCommand, type HostEvent, type ScheduleTask } from "@spcode/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  boxDecrypt,
  boxEncrypt,
  deriveOtpKey,
  generateBoxKeyPair,
  secretboxEncrypt,
} from "../src/main/remote/crypto.js";
import { RemoteServer } from "../src/main/remote/index.js";
import { PairingManager } from "../src/main/remote/pairing.js";
import { PushService } from "../src/main/remote/push.js";
import { LanTransport } from "../src/main/remote/transport/lan.js";
import { deriveChannelId, RelayTransport } from "../src/main/remote/transport/relay.js";
import type { RegistryLike } from "../src/main/session-helpers.js";
import type { SessionRegistryEntry } from "../src/main/session-registry.js";

// ---------------------------------------------------------------------------
// 进程内假 relay：对齐 apps/relay 服务端的真实语义
// - ws://…/channel/<channelId>?role=host|device
// - 帧原样穿过（relay 不解析、不修改业务帧，不做 deviceId 路由）：
//   device→host：host 在线转发，离线进 toHost 队列，host 上线按 FIFO 补投；
//   host→device：**广播给全部在线设备**（无任何设备在线时进 toDevices 队列，
//   下一个设备上线补投）——多设备隔离靠逐设备加密 + 帧外层 deviceId 由客户端过滤；
// - 连接建立先发 relay.hello {role, queued} 再补投；
// - 第二个 host 连同一 channel：直接关闭（真实 relay 用 close code 4001）
// ---------------------------------------------------------------------------

interface ChannelState {
  host: WebSocket | null;
  devices: Set<WebSocket>;
  /** device→host 离线队列 */
  toHost: string[];
  /** host→device 离线队列（无设备在线时） */
  toDevices: string[];
}

class FakeRelay {
  private wss: WebSocketServer;
  private readonly channels = new Map<string, ChannelState>();
  readonly port: Promise<number>;

  constructor() {
    this.wss = new WebSocketServer({ port: 0 });
    this.port = new Promise((resolvePromise) => {
      this.wss.on("listening", () => {
        const addr = this.wss.address();
        resolvePromise(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    this.wss.on("connection", (ws, req) => this.accept(ws, req.url ?? ""));
  }

  private channel(id: string): ChannelState {
    let ch = this.channels.get(id);
    if (!ch) {
      ch = { host: null, devices: new Set(), toHost: [], toDevices: [] };
      this.channels.set(id, ch);
    }
    return ch;
  }

  private accept(ws: WebSocket, rawUrl: string): void {
    const url = new URL(rawUrl, "http://localhost");
    const m = /^\/channel\/([0-9a-f]+)$/.exec(url.pathname);
    const role = url.searchParams.get("role");
    if (!m || (role !== "host" && role !== "device")) {
      ws.close();
      return;
    }
    const ch = this.channel(m[1]!);

    if (role === "host") {
      if (ch.host) {
        ws.close(4001, "host_exists");
        return;
      }
      ch.host = ws;
      ws.send(JSON.stringify({ t: "relay.hello", role: "host", queued: ch.toHost.length }));
      // FIFO 补投离线队列（帧沿用发送方原始 seq）
      for (const text of ch.toHost) ws.send(text);
      ch.toHost = [];
      ws.on("message", (data: Buffer) => this.routeFromHost(ch, data.toString()));
      ws.on("close", () => {
        if (ch.host === ws) ch.host = null;
      });
      return;
    }

    ch.devices.add(ws);
    ws.send(JSON.stringify({ t: "relay.hello", role: "device", queued: ch.toDevices.length }));
    for (const text of ch.toDevices) ws.send(text);
    ch.toDevices = [];
    ws.on("message", (data: Buffer) => {
      const text = data.toString();
      if (ch.host && ch.host.readyState === WebSocket.OPEN) ch.host.send(text);
      else ch.toHost.push(text);
    });
    ws.on("close", () => {
      ch.devices.delete(ws);
    });
  }

  /** host→device：广播给全部在线设备；无设备在线时入队等下一设备补投 */
  private routeFromHost(ch: ChannelState, text: string): void {
    if (ch.devices.size === 0) {
      ch.toDevices.push(text);
      return;
    }
    for (const dev of ch.devices) {
      if (dev.readyState === WebSocket.OPEN) dev.send(text);
    }
  }

  /** 模拟 host 侧网络中断（relay 主动踢掉 host 连接） */
  dropHost(channelId: string): void {
    const ch = this.channels.get(channelId);
    ch?.host?.terminate();
  }

  queuedCount(channelId: string): number {
    return this.channels.get(channelId)?.toHost.length ?? 0;
  }

  async stop(): Promise<void> {
    for (const ch of this.channels.values()) {
      ch.host?.terminate();
      for (const d of ch.devices) d.terminate();
    }
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}

// ---------------------------------------------------------------------------
// 测试用设备端（手机 PWA 替身）：经 relay 配对/auth/加密命令
// ---------------------------------------------------------------------------

interface WireFrame {
  t?: string;
  ok?: boolean;
  c?: string;
  deviceId?: string;
  seq?: number;
  [k: string]: unknown;
}

class RelayDevice {
  readonly phone = generateBoxKeyPair();
  deviceId: string | null = null;
  private ws!: WebSocket;
  private frames: WireFrame[] = [];
  private payloads: Record<string, unknown>[] = [];
  /** 不是发给本设备的密文帧（deviceId 不匹配或解密失败）——relay 广播语义下的正常事件 */
  readonly foreignFrames: WireFrame[] = [];
  private outSeq = 0;

  constructor(
    private readonly relayBase: string,
    private readonly channelId: string,
    private readonly desktopPk: string,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const ws = new WebSocket(`${this.relayBase}/channel/${this.channelId}?role=device`);
      this.ws = ws;
      ws.on("message", (data: Buffer) => {
        let frame: WireFrame;
        try {
          frame = JSON.parse(data.toString()) as WireFrame;
        } catch {
          return;
        }
        if (frame.t === "relay.hello" || frame.t === "relay.error") return;
        this.frames.push(frame);
        if (frame.t === "encrypted" && typeof frame.c === "string") {
          // relay 是广播语义：先用 deviceId 过滤，再解密；解不开即非本设备帧
          if (this.deviceId && frame.deviceId && frame.deviceId !== this.deviceId) {
            this.foreignFrames.push(frame);
            return;
          }
          const plain = boxDecrypt(frame.c, this.desktopPk, this.phone.secretKey);
          if (plain) this.payloads.push(JSON.parse(plain) as Record<string, unknown>);
          else this.foreignFrames.push(frame);
        }
      });
      ws.on("open", () => resolvePromise());
      ws.on("error", rejectPromise);
    });
  }

  /** 重连 = 新 WS + 出站 seq 归零（seq 生命周期绑定连接） */
  async reconnect(): Promise<void> {
    this.ws.close();
    this.outSeq = 0;
    await this.connect();
  }

  private sendRaw(frame: WireFrame): void {
    const tagged = this.deviceId && !("deviceId" in frame) ? { ...frame, deviceId: this.deviceId } : frame;
    this.ws.send(JSON.stringify(tagged));
  }

  async pair(otp: string, name = "relay 测试机"): Promise<void> {
    const c = secretboxEncrypt(JSON.stringify({ publicKey: this.phone.publicKey, name }), deriveOtpKey(otp));
    this.sendRaw({ t: "pair", otp, c });
    const ack = await this.waitFrame((f) => f.t === "pair_ack");
    expect(ack.ok).toBe(true);
    const inner = JSON.parse(boxDecrypt(ack.c!, this.desktopPk, this.phone.secretKey)!) as {
      desktopPk: string;
      deviceId: string;
    };
    expect(inner.desktopPk).toBe(this.desktopPk);
    this.deviceId = inner.deviceId;
  }

  async auth(): Promise<void> {
    this.sendRaw({ t: "auth", publicKey: this.phone.publicKey, deviceId: this.deviceId ?? undefined });
    const ack = await this.waitFrame((f) => f.t === "auth_ack");
    expect(ack.ok).toBe(true);
  }

  /** 发送加密命令（帧外层带 deviceId 供 relay 路由） */
  sendCmd(id: string, command: unknown): void {
    this.sendRaw({
      id,
      seq: this.outSeq++,
      t: "encrypted",
      c: boxEncrypt(JSON.stringify({ kind: "command", command }), this.desktopPk, this.phone.secretKey),
    });
  }

  /** 原样重发一个加密帧（重放测试） */
  replayEncrypted(id: string, seq: number, command: unknown): void {
    this.sendRaw({
      id,
      seq,
      t: "encrypted",
      c: boxEncrypt(JSON.stringify({ kind: "command", command }), this.desktopPk, this.phone.secretKey),
    });
  }

  waitFrame(pred: (f: WireFrame) => boolean, timeoutMs = 3000): Promise<WireFrame> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolvePromise, rejectPromise) => {
      const poll = setInterval(() => {
        const found = this.frames.find(pred);
        if (found) {
          clearInterval(poll);
          clearTimeout(timer);
          resolvePromise(found);
        }
      }, 10);
      const timer = setTimeout(() => {
        clearInterval(poll);
        rejectPromise(new Error("waitFrame 超时"));
      }, timeoutMs);
    });
  }

  waitPayload(pred: (p: Record<string, unknown>) => boolean, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const hit = this.payloads.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolvePromise, rejectPromise) => {
      const poll = setInterval(() => {
        const found = this.payloads.find(pred);
        if (found) {
          clearInterval(poll);
          clearTimeout(timer);
          resolvePromise(found);
        }
      }, 10);
      const timer = setTimeout(() => {
        clearInterval(poll);
        rejectPromise(new Error("waitPayload 超时"));
      }, timeoutMs);
    });
  }

  close(): void {
    this.ws.close();
  }
}

// ---------------------------------------------------------------------------
// 环境装配
// ---------------------------------------------------------------------------

let dir = "";
let relay: FakeRelay;
let relayBase = "";
let channelId = "";
let pairing: PairingManager;
let lan: LanTransport;
let relayTransport: RelayTransport;
let server: RemoteServer;
let bridgeCalls: HostCommand[];
let bridgeListeners: Set<(e: HostEvent) => void>;
let relayLogs: { msg: string; extra?: unknown }[];
const devices: RelayDevice[] = [];

const emitHost = (e: HostEvent) => {
  for (const l of bridgeListeners) l(e);
};

async function makeDevice(name?: string): Promise<RelayDevice> {
  const dev = new RelayDevice(relayBase, channelId, pairing.getIdentity().publicKey);
  await dev.connect();
  const { otp } = server.regeneratePairing();
  await dev.pair(otp, name);
  await dev.auth();
  devices.push(dev);
  return dev;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "spcode-remote-relay-"));
  pairing = new PairingManager({ baseDir: dir });
  relay = new FakeRelay();
  const port = await relay.port;
  relayBase = `ws://127.0.0.1:${port}`;
  channelId = deriveChannelId(pairing.getIdentity().publicKey);

  relayLogs = [];
  relayTransport = new RelayTransport({
    url: relayBase,
    channelId,
    reconnectInitialMs: 50,
    reconnectMaxMs: 200,
    log: (msg, extra) => relayLogs.push({ msg, extra }),
  });
  lan = new LanTransport({ port: 0, staticDir: join(dir, "pwa-not-built") });

  bridgeCalls = [];
  bridgeListeners = new Set();
  const registryEntries = new Map<string, SessionRegistryEntry>();
  const registry: RegistryLike = {
    list: () => [...registryEntries.values()],
    get: (id) => registryEntries.get(id),
    upsert: (entry) => void registryEntries.set(entry.id, entry),
    patch: (id, patch) => {
      const cur = registryEntries.get(id);
      if (cur) registryEntries.set(id, { ...cur, ...patch, id, updatedAt: Date.now() });
    },
    remove: (id) => void registryEntries.delete(id),
  };
  const bridge = {
    onEvent(cb: (e: HostEvent) => void) {
      bridgeListeners.add(cb);
      return () => bridgeListeners.delete(cb);
    },
    emitLocal(e: HostEvent) {
      for (const l of bridgeListeners) l(e);
    },
    async call(cmd: HostCommand & { id: string }) {
      bridgeCalls.push(cmd);
      return { ok: true };
    },
    replyPermission: () => {},
    replyQuestion: () => {},
  };
  const scheduler = {
    list: (): ScheduleTask[] => [],
    create: () => {
      throw new Error("not used");
    },
    update: () => null,
    remove: () => {},
    runNow: async () => "x",
  };
  const settings = {
    get: () => ({
      ...DEFAULT_SETTINGS,
      remote: { enabled: true, port: 0, relayUrl: relayBase, tailscale: false, pushEnabled: false },
    }),
  };

  server = new RemoteServer({
    settings,
    bridge,
    scheduler,
    registry,
    pairing,
    transport: lan,
    relayTransport,
    push: new PushService({ baseDir: dir }),
  });
  await server.start();
  // relay transport 后台连接，等待首次连上
  await waitUntil(() => relayTransport.getState() === "connected");
});

afterAll(async () => {
  for (const d of devices) d.close();
  await server.stop();
  await lan.stop();
  await relayTransport.stop();
  await relay.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const poll = setInterval(() => {
      if (pred()) {
        clearInterval(poll);
        clearTimeout(timer);
        resolvePromise();
      }
    }, 10);
    const timer = setTimeout(() => {
      clearInterval(poll);
      rejectPromise(new Error("waitUntil 超时"));
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("relay transport 基础", () => {
  it("channelId = sha256(公钥原始字节) hex；QR urls 携带 relay+ 前缀；status 透出 relay 状态", () => {
    expect(channelId).toMatch(/^[0-9a-f]{64}$/);
    const urls = server.urls();
    expect(urls.some((u) => u === `relay+${relayBase}`)).toBe(true);
    expect(urls.some((u) => u.startsWith("http://"))).toBe(true); // 局域网项仍在
    expect(server.status().relay).toBe("connected");
    // QR payload 的 hosts 里带 relay+wss:// 前缀项
    const info = server.regeneratePairing();
    const hosts = decodeURIComponent(new URL(info.qrPayload).searchParams.get("hosts") ?? "");
    expect(hosts.split(",")).toContain(`relay+${relayBase}`);
  });
});

describe("经 relay 配对 + 加密命令往返", () => {
  it("pair → auth → session.list 加密命令响应", async () => {
    const dev = await makeDevice("手机 A");
    expect(dev.deviceId).toBeTruthy();

    dev.sendCmd("cmd-list-1", { type: "session.list" });
    const resp = await dev.waitPayload((p) => p.kind === "response" && p.id === "cmd-list-1");
    expect(resp.ok).toBe(true);
    expect(resp.data).toEqual({ sessions: [] });
  });
});

describe("断线期间队列补投", () => {
  it("host 断线时 device 命令进 relay 队列，重连后按原 seq 补投且不误判重放", async () => {
    const dev = await makeDevice("补投机");
    // 先正常跑一条命令（入站 seq 推进到 0）
    dev.sendCmd("cmd-before", { type: "session.list" });
    await dev.waitPayload((p) => p.kind === "response" && p.id === "cmd-before");

    // host 侧断线：relay 踢掉 host 连接，transport 进入退避重连
    relay.dropHost(channelId);
    await waitUntil(() => relayTransport.getState() === "connecting");

    // 断线期间发命令（seq=1）→ relay 入队
    dev.sendCmd("cmd-queued", { type: "session.list" });
    await waitUntil(() => relay.queuedCount(channelId) === 1);

    // 等待自动重连 → relay.hello 报告补投 → 队列冲刷 → 命令被执行
    await waitUntil(() => relayTransport.getState() === "connected");
    const resp = await dev.waitPayload((p) => p.kind === "response" && p.id === "cmd-queued");
    expect(resp.ok).toBe(true);
    expect(relayLogs.some((l) => l.msg === "relay.hello" && (l.extra as { queued?: number })?.queued === 1)).toBe(true);
  });
});

describe("多设备隔离", () => {
  it("两台设备经同一 relay 通道：帧按 deviceId 标记、各自只能解开自己的（relay 广播语义）", async () => {
    const a = await makeDevice("手机 B1");
    const b = await makeDevice("手机 B2");
    expect(a.deviceId).not.toBe(b.deviceId);
    const aForeignBefore = a.foreignFrames.length;
    const bForeignBefore = b.foreignFrames.length;

    emitHost({ type: "session.event", sessionId: "s-iso", event: { type: "agent_start" } });
    const isStatus = (p: Record<string, unknown>) =>
      p.kind === "event" && (p.event as { type?: string })?.type === "session.status";
    // 双方都收到并解开自己的事件帧（各设备独立加密）
    await a.waitPayload(isStatus);
    await b.waitPayload(isStatus);

    // relay 广播语义：他设备的帧也会到达本端，但都带他设备 deviceId 且解不开
    await waitUntil(() => a.foreignFrames.length > aForeignBefore && b.foreignFrames.length > bForeignBefore);
    for (const f of a.foreignFrames.slice(aForeignBefore)) expect(f.deviceId).not.toBe(a.deviceId);
    for (const f of b.foreignFrames.slice(bForeignBefore)) expect(f.deviceId).not.toBe(b.deviceId);
    // 本轮广播里确实能看到对方设备的帧（channel 里还有先前测试的设备在线，故只断言包含）
    expect(a.foreignFrames.slice(aForeignBefore).some((f) => f.deviceId === b.deviceId)).toBe(true);
    expect(b.foreignFrames.slice(bForeignBefore).some((f) => f.deviceId === a.deviceId)).toBe(true);
  });
});

describe("断线补拉（session.output.since → session.output.backfill）", () => {
  it("按 afterSeq 过滤、seq 升序；session.remove 后缓冲清空", async () => {
    const dev = await makeDevice("补拉机");
    // 产生两个 output chunk：text_delta 经 agent_settled 冲刷，seq 0 / 1
    emitHost({
      type: "session.event",
      sessionId: "s-out",
      event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好" } },
    });
    emitHost({ type: "session.event", sessionId: "s-out", event: { type: "agent_settled" } });
    emitHost({
      type: "session.event",
      sessionId: "s-out",
      event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "世界" } },
    });
    emitHost({ type: "session.event", sessionId: "s-out", event: { type: "agent_settled" } });
    // 实时广播也应到达
    await dev.waitPayload(
      (p) => p.kind === "event" && (p.event as { type?: string; seq?: number })?.type === "session.output",
    );

    // afterSeq=0 → 只补 seq 1
    dev.sendCmd("cmd-since-0", { type: "session.output.since", sessionId: "s-out", afterSeq: 0 });
    const bf1 = await dev.waitPayload(
      (p) => p.kind === "event" && (p.event as { type?: string })?.type === "session.output.backfill",
    );
    const event1 = bf1.event as { sessionId: string; chunks: { seq: number; kind: string; chunk: string }[] };
    expect(event1.sessionId).toBe("s-out");
    expect(event1.chunks).toEqual([{ seq: 1, kind: "text", chunk: "世界" }]);
    const resp1 = await dev.waitPayload((p) => p.kind === "response" && p.id === "cmd-since-0");
    expect(resp1.ok).toBe(true);

    // afterSeq=-1 → 全部两个 chunk，升序
    dev.sendCmd("cmd-since-all", { type: "session.output.since", sessionId: "s-out", afterSeq: -1 });
    await dev.waitPayload((p) => p.kind === "response" && p.id === "cmd-since-all");
    const bf2 = await dev.waitPayload((p) => {
      if (p.kind !== "event") return false;
      const e = p.event as { type?: string; chunks?: unknown[] };
      return e.type === "session.output.backfill" && e.chunks?.length === 2;
    });
    const event2 = bf2.event as { chunks: { seq: number; chunk: string }[] };
    expect(event2.chunks.map((c) => c.seq)).toEqual([0, 1]);
    expect(event2.chunks.map((c) => c.chunk)).toEqual(["你好", "世界"]);

    // session.remove 后缓冲清空
    dev.sendCmd("cmd-rm", { type: "session.remove", sessionId: "s-out" });
    await dev.waitPayload((p) => p.kind === "response" && p.id === "cmd-rm");
    dev.sendCmd("cmd-since-empty", { type: "session.output.since", sessionId: "s-out", afterSeq: -1 });
    await dev.waitPayload((p) => p.kind === "response" && p.id === "cmd-since-empty");
    const bf3 = await dev.waitPayload((p) => {
      if (p.kind !== "event") return false;
      const e = p.event as { type?: string; chunks?: unknown[] };
      return e.type === "session.output.backfill" && e.chunks?.length === 0;
    });
    expect(bf3).toBeTruthy();
  });
});

describe("seq 绑定逻辑连接", () => {
  it("设备重连重新 auth 后入站 seq 从 0 重新开始；重放被断连并墓碑，重新 auth 恢复", async () => {
    const dev = await makeDevice("seq 机");
    dev.sendCmd("seq-c1", { type: "session.list" });
    await dev.waitPayload((p) => p.kind === "response" && p.id === "seq-c1");

    // 设备重连 relay（新 WS，出站 seq 归零）→ 重新 auth → host 重置该设备入站校验
    await dev.reconnect();
    await dev.auth();
    dev.sendCmd("seq-c2", { type: "session.list" }); // seq=0：不重置会被当重放拒绝
    const resp = await dev.waitPayload((p) => p.kind === "response" && p.id === "seq-c2");
    expect(resp.ok).toBe(true);

    // 重放同一 seq=0 → host 关闭该虚拟连接（墓碑）；后续业务帧被丢弃
    dev.replayEncrypted("seq-c2b", 0, { type: "session.list" });
    await new Promise((r) => setTimeout(r, 200));
    dev.sendCmd("seq-c3", { type: "session.list" });
    await expect(dev.waitPayload((p) => p.kind === "response" && p.id === "seq-c3", 500)).rejects.toThrow("超时");

    // 重新 auth = 新逻辑会话：墓碑清除，seq 重新从 0 计
    await dev.reconnect();
    await dev.auth();
    dev.sendCmd("seq-c4", { type: "session.list" });
    const resp4 = await dev.waitPayload((p) => p.kind === "response" && p.id === "seq-c4");
    expect(resp4.ok).toBe(true);
  });
});
