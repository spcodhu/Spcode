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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RemoteServer } from "../../desktop/src/main/remote/index.js";
import { PairingManager } from "../../desktop/src/main/remote/pairing.js";
import { LanTransport } from "../../desktop/src/main/remote/transport/lan.js";
import type { RegistryLike } from "../../desktop/src/main/session-helpers.js";
import type { SessionRegistryEntry } from "../../desktop/src/main/session-registry.js";
import { type ConnectionState, PairError, pairWithQr, RemoteClient } from "../src/lib/client";
import type { PairingRecord } from "../src/lib/db";

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
  const settings = { get: () => ({ ...DEFAULT_SETTINGS, remote: { enabled: true, port: 0 } }) };

  server = new RemoteServer({ settings, bridge, scheduler, registry, pairing, transport });
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
  return `spcode-remote://pair?v=1&hosts=${hosts}&desktop_pk=${pk}&otp=${info.otp}`;
}

/** QR payload 的 hosts 替换为 127.0.0.1（集成测试强制走回环，避免依赖机器网卡） */
function localQrPayload(): string {
  const info = server.regeneratePairing();
  const hosts = encodeURIComponent(`http://127.0.0.1:${port}`);
  const pk = encodeURIComponent(pairing.getIdentity().publicKey);
  return `spcode-remote://pair?v=1&hosts=${hosts}&desktop_pk=${pk}&otp=${info.otp}`;
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
    const bad = `spcode-remote://pair?v=1&hosts=${hosts}&desktop_pk=${pk}&otp=${wrongOtp}`;
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

  it("未配对设备 auth → unpaired 状态（不再自动重连）", async () => {
    const stranger: PairingRecord = {
      version: 1,
      desktopPk: pairing.getIdentity().publicKey,
      deviceId: "nobody",
      hosts: [`http://127.0.0.1:${port}`],
      deviceName: "陌生设备",
      keyPair: (await import("../src/lib/crypto")).generateKeyPair(),
      pairedAt: Date.now(),
    };
    const mobile = new MobileTestClient(stranger);
    mobile.start();
    await mobile.waitState("unpaired");
    mobile.stop();
  });
});
