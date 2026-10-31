/**
 * 集成测试（关键验证）：PWA 协议实现 ↔ 真实桌面 RemoteServer 全链路。
 *
 * 装配方式同 apps/desktop/test/remote-lan.test.ts（真实端口 0 + mock bridge/scheduler/registry），
 * 但客户端完全走 apps/mobile 的实现（pairWithQr / RemoteClient / crypto），
 * 验证 pair → snapshot → 加密命令往返 → 事件广播 → auth 重连，提前发现两端实现不一致。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteEvent } from "@spcode/shared";
import { DEFAULT_SETTINGS, type HostCommand, type HostEvent, type ScheduleTask } from "@spcode/shared";
import { getLocale, resolveLocale, setLocale } from "@spcode/shared/i18n";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RemoteServer } from "../../desktop/src/main/remote/index.js";
import { PairingManager } from "../../desktop/src/main/remote/pairing.js";
import { PushService } from "../../desktop/src/main/remote/push.js";
import { LanTransport } from "../../desktop/src/main/remote/transport/lan.js";
import type { RegistryLike } from "../../desktop/src/main/session-helpers.js";
import type { SessionRegistryEntry } from "../../desktop/src/main/session-registry.js";
import { createRelayServer } from "../../relay/src/index.js";
import { type ConnectionState, PairError, pairWithQr, RemoteClient } from "../src/lib/client";
import type { PairingRecord } from "../src/lib/db";
import { attachPairedRecord, getClient } from "../src/state/controller";
import { useAppStore } from "../src/state/store";

// ---------------------------------------------------------------------------
// 桌面端装配（mock 控制面，真实 transport + crypto + pairing）
// ---------------------------------------------------------------------------

let dir = "";
let port = 0;
let pairing: PairingManager;
let transport: LanTransport;
let server: RemoteServer;
let bridgeCalls: HostCommand[];
let bridgeListeners: Set<(e: HostEvent) => void>;
let registryEntries: Map<string, SessionRegistryEntry>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "spcode-mobile-it-"));
  pairing = new PairingManager({ baseDir: dir });
  transport = new LanTransport({ port: 0, staticDir: join(dir, "pwa-not-built") });
  bridgeCalls = [];
  bridgeListeners = new Set();
  registryEntries = new Map();

  const registry: RegistryLike = {
    list: () => [...registryEntries.values()],
    get: (id) => registryEntries.get(id),
    upsert: (entry) => void registryEntries.set(entry.id, entry),
    patch: (id, patch) => {
      const cur = registryEntries.get(id);
      if (cur) registryEntries.set(id, { ...cur, ...patch, id, updatedAt: Date.now() });
    },
  };
  const bridge = {
    onEvent(cb: (e: HostEvent) => void) {
      bridgeListeners.add(cb);
      return () => bridgeListeners.delete(cb);
    },
    async call(cmd: HostCommand & { id: string }) {
      bridgeCalls.push(cmd);
      if (cmd.type === "session.create") return { sessionId: cmd.payload.sessionId, sessionFile: null };
      if (cmd.type === "session.history") {
        return {
          messages: [
            { role: "user", content: [{ type: "text", text: "手机历史问题" }] },
            { role: "assistant", content: [{ type: "text", text: "手机历史回答" }] },
          ],
        };
      }
      return { ok: true };
    },
    replyPermission: () => {},
    replyQuestion: () => {},
    emitLocal(event: HostEvent) {
      for (const listener of bridgeListeners) listener(event);
    },
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
  const settings = { get: () => ({ ...DEFAULT_SETTINGS, remote: { enabled: true, port: 0 } }) };

  server = new RemoteServer({
    settings,
    bridge,
    scheduler,
    registry,
    pairing,
    transport,
    push: new PushService({ baseDir: dir }),
  });
  await server.start();
  port = transport.getPort();
  expect(port).toBeGreaterThan(0);
});

afterAll(async () => {
  await server.stop();
  await transport.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** 桌面设置页同款的 QR payload；无 LAN 地址时退回 127.0.0.1 */
function freshQrPayload(): string {
  const info = server.regeneratePairing();
  if (info.urls.length > 0) return info.qrPayload;
  const hosts = encodeURIComponent(`http://127.0.0.1:${port}`);
  const pk = encodeURIComponent(pairing.getIdentity().publicKey);
  return `spcode-remote://pair?v=2&hosts=${hosts}&desktop_pk=${pk}&otp=${info.otp}`;
}

/** QR payload 的 hosts 替换为 127.0.0.1（集成测试强制走回环，避免依赖机器网卡） */
function localQrPayload(): string {
  const info = server.regeneratePairing();
  const hosts = encodeURIComponent(`http://127.0.0.1:${port}`);
  const pk = encodeURIComponent(pairing.getIdentity().publicKey);
  return `spcode-remote://pair?v=2&hosts=${hosts}&desktop_pk=${pk}&otp=${info.otp}`;
}

// ---------------------------------------------------------------------------
// 测试客户端封装
// ---------------------------------------------------------------------------

class MobileTestClient {
  readonly events: RemoteEvent[] = [];
  readonly states: ConnectionState[] = [];
  readonly client: RemoteClient;

  constructor(record: PairingRecord) {
    this.client = new RemoteClient(record, {
      onEvent: (e) => this.events.push(e),
      onState: (s) => this.states.push(s),
    });
  }

  start(): void {
    this.client.start();
  }

  stop(): void {
    this.client.stop();
  }

  async waitState(state: ConnectionState, timeoutMs = 8000): Promise<void> {
    if (this.states.includes(state)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`等待状态 ${state} 超时（已到：${this.states.join(",")}）`)),
        timeoutMs,
      );
      const poll = setInterval(() => {
        if (this.states.includes(state)) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 10);
    });
  }

  async waitEvent(pred: (e: RemoteEvent) => boolean, timeoutMs = 8000, what = "事件"): Promise<RemoteEvent> {
    const hit = this.events.find(pred);
    if (hit) return hit;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `等待${what}超时（已收：${this.events.map((e) => e.type).join(",")}；状态：${this.states.join(",")}）`,
            ),
          ),
        timeoutMs,
      );
      const poll = setInterval(() => {
        const found = this.events.find(pred);
        if (found) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve(found);
        }
      }, 10);
    });
  }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("PWA ↔ 真实桌面 RemoteServer 全链路", () => {
  it("pairWithQr：配对握手成功，返回的桌面公钥与桌面身份一致", async () => {
    const record = await pairWithQr(localQrPayload(), "集成测试手机");
    expect(record.desktopPk).toBe(pairing.getIdentity().publicKey);
    expect(record.deviceId).toBeTruthy();
    expect(record.hosts.length).toBeGreaterThan(0);
  });

  it("QR payload 使用桌面广告地址（LAN IP）也能配对", async () => {
    const qr = freshQrPayload();
    if (!qr.includes("hosts=") || qr.includes(`hosts=${encodeURIComponent("")}`)) return; // 无网卡环境跳过
    const record = await pairWithQr(qr, "LAN 地址测试机");
    expect(record.desktopPk).toBe(pairing.getIdentity().publicKey);
  });

  it("错误 OTP → PairError otp_mismatch", async () => {
    const info = server.regeneratePairing();
    const wrongOtp = info.otp === "00000000" ? "00000001" : "00000000";
    const hosts = encodeURIComponent(`http://127.0.0.1:${port}`);
    const pk = encodeURIComponent(pairing.getIdentity().publicKey);
    const bad = `spcode-remote://pair?v=2&hosts=${hosts}&desktop_pk=${pk}&otp=${wrongOtp}`;
    await expect(pairWithQr(bad, "错误 OTP 机")).rejects.toBeInstanceOf(PairError);
    await expect(pairWithQr(bad, "错误 OTP 机")).rejects.toMatchObject({ code: "otp_mismatch" });
  });

  it("auth 建连 → snapshot → create/prompt/list/abort → 事件广播 → 断线重连", async () => {
    const record = await pairWithQr(localQrPayload(), "全链路测试机");
    const mobile = new MobileTestClient(record);
    mobile.start();
    try {
      // 1) auth 握手成功 → 桌面立即推 session.snapshot
      await mobile.waitState("ready");
      await mobile.waitEvent((e) => e.type === "session.snapshot");
      expect(await mobile.waitEvent((e) => e.type === "remote.hello")).toMatchObject({
        type: "remote.hello",
        locale: DEFAULT_SETTINGS.locale,
      });

      // 2) 加密命令：create → prompt → list → abort（seq 自动递增，响应按 id 关联）
      const { sessionId } = await mobile.client.command<{ sessionId: string }>({
        type: "session.create",
        mode: "chat",
        prompt: "来自手机的集成测试会话",
      });
      expect(sessionId).toBeTruthy();

      await mobile.client.command({ type: "session.prompt", sessionId, text: "继续" });
      const list = await mobile.client.command<{ sessions: { id: string; title: string }[] }>({ type: "session.list" });
      expect(list.sessions.some((s) => s.id === sessionId)).toBe(true);
      expect(registryEntries.get(sessionId)?.title).toBe("来自手机的集成测试会话");

      // 3) bridge 事件 → 桌面聚合器 → 加密事件帧推到手机
      for (const l of bridgeListeners) l({ type: "session.event", sessionId, event: { type: "agent_start" } });
      await mobile.waitEvent((e) => e.type === "session.status" && e.sessionId === sessionId && e.status === "running");

      // 4) abort 后 bridge 调用序列：create → prompt ×2（create 自带首条 prompt）→ prompt → abort
      await mobile.client.command({ type: "session.abort", sessionId });
      expect(bridgeCalls.map((c) => c.type)).toEqual([
        "session.create",
        "session.prompt",
        "session.prompt",
        "session.abort",
      ]);
    } finally {
      mobile.stop();
    }

    // 5) 断线后重连（auth 模式）：同一配对记录新连接 → ready + 新快照
    const mobile2 = new MobileTestClient(record);
    mobile2.start();
    try {
      await mobile2.waitState("ready");
      await mobile2.waitEvent((e) => e.type === "session.snapshot");
    } finally {
      mobile2.stop();
    }
  });

  it("已有会话可通过真实远程协议读取历史页", async () => {
    const sessionId = "mobile-history-session";
    registryEntries.set(sessionId, {
      id: sessionId,
      mode: "chat",
      cwd: "",
      title: "手机历史会话",
      titleKind: "custom",
      model: null,
      thinkingLevel: "medium",
      sessionFile: "/tmp/mobile-history.jsonl",
      createdAt: 1,
      updatedAt: 2,
    });
    const record = await pairWithQr(localQrPayload(), "历史读取测试机");
    const mobile = new MobileTestClient(record);
    mobile.start();
    try {
      await mobile.waitState("ready");
      const page = await mobile.client.command<{
        chunks: { kind: string; chunk: string }[];
        olderBefore: number | null;
        outputSeq: number;
      }>({ type: "session.history", sessionId });
      expect(page.chunks).toEqual([
        { kind: "user", chunk: "手机历史问题" },
        { kind: "text", chunk: "手机历史回答" },
      ]);
      expect(page.olderBefore).toBeNull();
      expect(page.outputSeq).toBe(-1);
    } finally {
      mobile.stop();
    }
  });

  it("未配对设备 auth → unpaired 状态（不再自动重连）", async () => {
    const stranger: PairingRecord = {
      version: 1,
      desktopPk: pairing.getIdentity().publicKey,
      deviceId: "nobody",
      hosts: [`http://127.0.0.1:${port}`],
      deviceName: "陌生设备",
      keyPair: (await import("@spcode/shared/crypto")).generateBoxKeyPair(),
      pairedAt: Date.now(),
    };
    const mobile = new MobileTestClient(stranger);
    mobile.start();
    await mobile.waitState("unpaired");
    mobile.stop();
  });

  it("encrypted hello and locale.changed reach the controller without rewriting raw session data", async () => {
    const record = await pairWithQr(localQrPayload(), "locale integration device");
    setLocale("en");
    useAppStore.getState().reset();
    attachPairedRecord(record);
    try {
      await vi.waitFor(() => expect(useAppStore.getState().localeReady).toBe(true));
      expect(getLocale()).toBe(resolveLocale(DEFAULT_SETTINGS.locale));
      const client = getClient()!;
      const { sessionId } = await client.command<{ sessionId: string }>({
        type: "session.create",
        mode: "chat",
        prompt: "原始 raw session title",
      });
      await vi.waitFor(() => expect(useAppStore.getState().sessions[sessionId]?.title).toBe("原始 raw session title"));
      for (const listener of bridgeListeners) {
        listener({
          type: "session.event",
          sessionId,
          event: {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "原始 model output {{keep}}" },
          },
        } as HostEvent);
        listener({ type: "session.event", sessionId, event: { type: "agent_settled" } } as HostEvent);
      }
      await vi.waitFor(() =>
        expect(useAppStore.getState().outputs[sessionId]?.[0]?.chunk).toBe("原始 model output {{keep}}"),
      );
      const before = useAppStore.getState().outputs[sessionId];
      server.setLocale("en");
      await vi.waitFor(() => expect(getLocale()).toBe(resolveLocale("en")));
      expect(useAppStore.getState().outputs[sessionId]).toBe(before);
      expect(useAppStore.getState().sessions[sessionId]?.title).toBe("原始 raw session title");
      server.setLocale("zh-CN");
      await vi.waitFor(() => expect(getLocale()).toBe(resolveLocale("zh-CN")));
      expect(useAppStore.getState().outputs[sessionId]).toBe(before);
    } finally {
      getClient()?.stop();
      useAppStore.getState().reset();
      setLocale(DEFAULT_SETTINGS.locale);
    }
  });
});

// ---------------------------------------------------------------------------
// 断线补拉（LAN 通道，复用上面的共享 server）
// ---------------------------------------------------------------------------

describe("断线补拉：session.output.since ↔ session.output.backfill", () => {
  it("离线期间的输出 chunk 可按 afterSeq 补拉（升序、只含 > afterSeq）", async () => {
    const record = await pairWithQr(localQrPayload(), "补拉测试机");
    const mobile = new MobileTestClient(record);
    mobile.start();

    let sessionId = "";
    const emit = (ev: unknown) => {
      for (const l of bridgeListeners) l({ type: "session.event", sessionId, event: ev } as HostEvent);
    };
    try {
      await mobile.waitState("ready");
      const created = await mobile.client.command<{ sessionId: string }>({
        type: "session.create",
        mode: "chat",
        prompt: "补拉会话",
      });
      sessionId = created.sessionId;

      // 制造 3 个 chunk：kind 切换 + agent_settled 触发聚合器冲刷
      // seq0 = text AAA；seq1 = thinking BBB；seq2 = text CCC
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "AAA" } });
      emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "BBB" } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "CCC" } });
      emit({ type: "agent_settled" });
      await mobile.waitEvent((e) => e.type === "session.output" && e.sessionId === sessionId && e.seq === 2);
    } finally {
      mobile.stop();
    }

    // 离线期间又产生两个 chunk：seq3 = text DDD；seq4 = thinking EEE
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "DDD" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "EEE" } });
    emit({ type: "agent_settled" });

    const mobile2 = new MobileTestClient(record);
    mobile2.start();
    try {
      await mobile2.waitState("ready");
      const res = await mobile2.client.command<{ count: number }>({
        type: "session.output.since",
        sessionId,
        afterSeq: 2,
      });
      expect(res.count).toBe(2);
      const backfill = (await mobile2.waitEvent(
        (e) => e.type === "session.output.backfill" && e.sessionId === sessionId,
        8000,
        "backfill 事件",
      )) as Extract<RemoteEvent, { type: "session.output.backfill" }>;
      expect(backfill.chunks.map((c) => c.seq)).toEqual([3, 4]);
      expect(backfill.chunks.map((c) => c.chunk)).toEqual(["DDD", "EEE"]);
      expect(backfill.chunks[1]!.kind).toBe("thinking");
    } finally {
      mobile2.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// relay 通道全链路（真实 relay 服务 + 真实 RemoteServer 自建 RelayTransport）
// ---------------------------------------------------------------------------

describe("PWA ↔ 桌面 RemoteServer 经 relay 全链路", () => {
  let dir2 = "";
  let relayPort = 0;
  let relayClose: (() => Promise<void>) | null = null;
  let pairing2: PairingManager;
  let server2: RemoteServer;
  let transport2: LanTransport;
  let bridgeListeners2: Set<(e: HostEvent) => void>;

  beforeAll(async () => {
    dir2 = mkdtempSync(join(tmpdir(), "spcode-mobile-it-relay-"));
    // 真实哑中继（apps/relay 同源装配，回环 + 随机端口）
    const relay = createRelayServer({
      port: 0,
      staticDir: join(dir2, "no-static"),
      queueMax: 1000,
      queueTtlMs: 3600_000,
      frameMaxBytes: 256 * 1024,
      ratePerSec: 600,
    });
    relayClose = relay.close;
    await new Promise<void>((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
    const addr = relay.server.address();
    relayPort = typeof addr === "object" && addr ? addr.port : 0;
    expect(relayPort).toBeGreaterThan(0);

    pairing2 = new PairingManager({ baseDir: dir2 });
    transport2 = new LanTransport({ port: 0, staticDir: join(dir2, "pwa-not-built") });
    bridgeListeners2 = new Set();
    const registry: RegistryLike = {
      list: () => [],
      get: () => undefined,
      upsert: () => {},
      patch: () => {},
    };
    const bridge = {
      onEvent(cb: (e: HostEvent) => void) {
        bridgeListeners2.add(cb);
        return () => bridgeListeners2.delete(cb);
      },
      async call(_cmd: HostCommand & { id: string }) {
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
    // relayUrl 非空 → RemoteServer 自建 RelayTransport（host 角色出站连 relay）
    const settings = {
      get: () => ({ ...DEFAULT_SETTINGS, remote: { enabled: true, port: 0, relayUrl: `ws://127.0.0.1:${relayPort}` } }),
    };
    server2 = new RemoteServer({
      settings,
      bridge,
      scheduler,
      registry,
      pairing: pairing2,
      transport: transport2,
      push: new PushService({ baseDir: dir2 }),
    });
    await server2.start();
  });

  afterAll(async () => {
    await server2?.stop();
    await transport2?.stop();
    await relayClose?.();
    if (dir2) rmSync(dir2, { recursive: true, force: true });
  });

  /** 只含 relay host 的 QR payload（强制走 relay 通道） */
  function relayQrPayload(): string {
    const info = server2.regeneratePairing();
    const hosts = encodeURIComponent(`relay+ws://127.0.0.1:${relayPort}`);
    const pk = encodeURIComponent(pairing2.getIdentity().publicKey);
    return `spcode-remote://pair?v=2&hosts=${hosts}&desktop_pk=${pk}&otp=${info.otp}`;
  }

  it("pair（无 deviceId）→ 重连 auth（带 deviceId）→ 加密命令往返 → 广播事件 → 重连", async () => {
    // 1) 经 relay 配对（pair 帧无 deviceId，host 走配对临时虚拟连接）
    const record = await pairWithQr(relayQrPayload(), "relay 测试机");
    expect(record.desktopPk).toBe(pairing2.getIdentity().publicKey);
    expect(record.deviceId).toBeTruthy();

    // 2) pair 后重新连接，先 auth（帧外层带 deviceId）再发加密命令
    const mobile = new MobileTestClient(record);
    mobile.start();
    try {
      await mobile.waitState("ready");
      await mobile.waitEvent((e) => e.type === "session.snapshot");

      expect(await mobile.waitEvent((e) => e.type === "remote.hello")).toMatchObject({
        type: "remote.hello",
        locale: DEFAULT_SETTINGS.locale,
      });
      server2.setLocale("en");
      expect(await mobile.waitEvent((e) => e.type === "locale.changed")).toEqual({
        type: "locale.changed",
        locale: "en",
      });

      // 3) 加密命令往返（device→host 帧带 deviceId，host 按它分流到虚拟连接）
      const list = await mobile.client.command<{ sessions: unknown[] }>({ type: "session.list" });
      expect(list.sessions).toEqual([]);

      // 4) host→device 广播帧带 deviceId 过滤元数据，本设备正常接收
      for (const l of bridgeListeners2) l({ type: "sessions.changed" });
      await mobile.waitEvent((e) => e.type === "sessions.changed");
    } finally {
      mobile.stop();
    }

    // 5) relay 重连：重新 auth（入站 seq 校验归零），加密命令继续工作
    const mobile2 = new MobileTestClient(record);
    mobile2.start();
    try {
      await mobile2.waitState("ready");
      await mobile2.waitEvent((e) => e.type === "session.snapshot");
      const list = await mobile2.client.command<{ sessions: unknown[] }>({ type: "session.list" });
      expect(list.sessions).toEqual([]);
    } finally {
      mobile2.stop();
    }
  });
});
