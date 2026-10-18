/**
 * 权限双端撤卡链路测试（M3）：
 * 远程端 permission.reply → bridge.replyPermission(requestId, approved, "remote")
 * → bridge emitLocal(permission.resolved) → RemoteServer 桥接订阅 → 聚合器透传
 * → 加密事件帧广播给全部已配对设备（对端据此关闭同 requestId 批准卡）。
 *
 * 同时覆盖：桌面本地裁决（by:"local"）也会转发给远程端。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type HostCommand, type HostEvent, type ScheduleTask } from "@spcode/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
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
import type { RegistryLike } from "../src/main/session-helpers.js";
import type { SessionRegistryEntry } from "../src/main/session-registry.js";

let dir = "";
let server: RemoteServer;
let transport: LanTransport;
let bridgeListeners: Set<(e: HostEvent) => void>;
let permissionReplies: { requestId: string; approved: boolean; by?: string }[];
const emitHost = (e: HostEvent) => {
  for (const l of bridgeListeners) l(e);
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "spcode-remote-perm-"));
  const pairing = new PairingManager({ baseDir: dir });
  transport = new LanTransport({ port: 0, staticDir: join(dir, "pwa-not-built") });
  bridgeListeners = new Set();
  permissionReplies = [];
  const registryEntries = new Map<string, SessionRegistryEntry>();
  const registry: RegistryLike = {
    list: () => [...registryEntries.values()],
    get: (id) => registryEntries.get(id),
    upsert: (entry) => void registryEntries.set(entry.id, entry),
    patch: () => {},
    remove: (id) => void registryEntries.delete(id),
  };
  // stub bridge 复刻 AgentBridge 契约：replyPermission 成功后 emitLocal(permission.resolved)
  const bridge = {
    onEvent(cb: (e: HostEvent) => void) {
      bridgeListeners.add(cb);
      return () => bridgeListeners.delete(cb);
    },
    async call(_cmd: HostCommand & { id: string }) {
      return { ok: true };
    },
    replyPermission(requestId: string, approved: boolean, by?: "local" | "remote") {
      permissionReplies.push({ requestId, approved, by });
      emitHost({ type: "permission.resolved", requestId, approved, by: by ?? "local" });
    },
    replyQuestion: () => {},
    emitLocal(e: HostEvent) {
      emitHost(e);
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
  const settings = {
    get: () => ({
      ...DEFAULT_SETTINGS,
      remote: { enabled: true, port: 0, relayUrl: null, tailscale: false, pushEnabled: false },
    }),
  };
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
});

afterAll(async () => {
  await server.stop();
  await transport.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** 已配对设备的加密帧收发助手 */
class PairedPhone {
  readonly keys = generateBoxKeyPair();
  private ws!: WebSocket;
  private frames: { t?: string; c?: string }[] = [];
  private desktopPk;
  private outSeq = 0;

  constructor(desktopPk: string) {
    this.desktopPk = desktopPk;
  }

  async connectAndPair(): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${transport.getPort()}/ws`);
    this.ws.on("message", (data: Buffer) => this.frames.push(JSON.parse(data.toString())));
    await new Promise<void>((r) => this.ws.on("open", () => r()));
    const { otp } = server.regeneratePairing();
    this.ws.send(
      JSON.stringify({
        t: "pair",
        otp,
        c: secretboxEncrypt(JSON.stringify({ publicKey: this.keys.publicKey, name: "撤卡机" }), deriveOtpKey(otp)),
      }),
    );
    await this.waitRaw((f) => f.t === "pair_ack");
  }

  private async waitRaw(pred: (f: { t?: string; c?: string }) => boolean, timeoutMs = 3000) {
    for (let i = 0; i < timeoutMs / 10; i++) {
      const hit = this.frames.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("waitRaw 超时");
  }

  /** 等待某类解密后的业务事件 */
  async waitEvent(type: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
    for (let i = 0; i < timeoutMs / 10; i++) {
      for (const f of this.frames) {
        if (f.t !== "encrypted" || !f.c) continue;
        const plain = boxDecrypt(f.c, this.desktopPk, this.keys.secretKey);
        if (!plain) continue;
        const p = JSON.parse(plain) as { kind: string; event?: Record<string, unknown> };
        if (p.kind === "event" && p.event?.type === type) return p.event;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`waitEvent(${type}) 超时`);
  }

  sendCommand(id: string, command: unknown): void {
    this.ws.send(
      JSON.stringify({
        id,
        seq: this.outSeq++,
        t: "encrypted",
        c: boxEncrypt(JSON.stringify({ kind: "command", command }), this.desktopPk, this.keys.secretKey),
      }),
    );
  }

  close(): void {
    this.ws.close();
  }
}

describe("permission.resolved 双端撤卡链路", () => {
  it('远程端 permission.reply → bridge 收到 by="remote" → 设备收到 permission.resolved 事件', async () => {
    const desktopPk = new PairingManager({ baseDir: dir }).getIdentity().publicKey;
    const phone = new PairedPhone(desktopPk);
    await phone.connectAndPair();
    try {
      // 1) 桌面侧广播权限请求（手机收到批准卡）
      emitHost({
        type: "permission.request",
        request: { requestId: "req-1", sessionId: "s1", toolName: "Bash", args: { command: "ls" }, risk: "write" },
      });
      const reqEvent = await phone.waitEvent("permission.request");
      expect((reqEvent.request as { requestId: string }).requestId).toBe("req-1");

      // 2) 手机批准：permission.reply 加密命令
      phone.sendCommand("cmd-approve", { type: "permission.reply", requestId: "req-1", approved: true });

      // 3) bridge 以 by="remote" 收到裁决
      await waitFor(() => permissionReplies.length === 1);
      expect(permissionReplies[0]).toEqual({ requestId: "req-1", approved: true, by: "remote" });

      // 4) 手机收到 permission.resolved（含本端来源标记，用于幂等关卡）
      const resolved = await phone.waitEvent("permission.resolved");
      expect(resolved).toMatchObject({ requestId: "req-1", approved: true, by: "remote" });
    } finally {
      phone.close();
    }
  });

  it('桌面本地裁决（by="local"）同样转发给远程端', async () => {
    const desktopPk = new PairingManager({ baseDir: dir }).getIdentity().publicKey;
    const phone = new PairedPhone(desktopPk);
    await phone.connectAndPair();
    try {
      emitHost({ type: "permission.resolved", requestId: "req-2", approved: false, by: "local" });
      const resolved = await phone.waitEvent("permission.resolved");
      expect(resolved).toMatchObject({ requestId: "req-2", approved: false, by: "local" });
    } finally {
      phone.close();
    }
  });
});

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  for (let i = 0; i < timeoutMs / 10; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor 超时");
}
