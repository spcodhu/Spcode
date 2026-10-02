/**
 * 局域网 Transport + RemoteServer 全链路集成测试（真实端口 0）：
 * HTTP 占位页 → WS 连接 → OTP 配对握手 → 加密命令（create→prompt→abort）→
 * 事件广播 → seq 重放断连 → auth 重连。
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
import { LanTransport } from "../src/main/remote/transport/lan.js";
import type { RegistryLike } from "../src/main/session-helpers.js";
import type { SessionRegistryEntry } from "../src/main/session-registry.js";

// ---------------------------------------------------------------------------
// 测试用 WS 客户端
// ---------------------------------------------------------------------------

class TestClient {
  private ws: WebSocket;
  private frames: unknown[] = [];
  private closeResolve: (() => void) | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: Buffer) => {
      try {
        this.frames.push(JSON.parse(data.toString()));
      } catch {
        // 忽略非 JSON
      }
    });
    ws.on("close", () => this.closeResolve?.());
  }

  static connect(url: string): Promise<TestClient> {
    return new Promise((resolvePromise, rejectPromise) => {
      const ws = new WebSocket(url);
      const client = new TestClient(ws);
      ws.on("open", () => resolvePromise(client));
      ws.on("error", rejectPromise);
    });
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** 等待满足条件的帧（先查已收缓冲，再等新帧） */
  async waitFor(pred: (frame: unknown) => boolean, timeoutMs = 3000): Promise<unknown> {
    const hit = this.frames.find(pred);
    if (hit) return hit;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("waitFor 超时")), timeoutMs);
      const check = () => {
        const found = this.frames.find(pred);
        if (found) {
          clearInterval(poll);
          clearTimeout(timer);
          resolvePromise(found);
        }
      };
      const poll = setInterval(check, 10);
    });
  }

  waitClosed(timeoutMs = 3000): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("等待断连超时")), timeoutMs);
      this.closeResolve = () => {
        clearTimeout(timer);
        resolvePromise();
      };
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
let port = 0;
let pairing: PairingManager;
let transport: LanTransport;
let server: RemoteServer;
let bridgeCalls: HostCommand[];
let bridgeListeners: Set<(e: HostEvent) => void>;
let registryEntries: Map<string, SessionRegistryEntry>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "spcode-remote-lan-"));
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
      if (cmd.type === "session.create") {
        return { sessionId: cmd.payload.sessionId, sessionFile: null };
      }
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

const wsUrl = () => `ws://127.0.0.1:${port}/ws`;

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("LAN transport HTTP 层", () => {
  it("PWA 未构建时服务占位页", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("尚未构建");
  });

  it("目录穿越被拒绝/无害化（不会读到 staticDir 外的文件）", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/../../etc/passwd`);
    const text = await res.text();
    // 占位页或 403/404 均可接受，关键是不能泄露 /etc/passwd
    expect(text).not.toContain("root:");
  });

  it("getAdvertisedUrls 返回 http://ip:port 列表", () => {
    const urls = transport.getAdvertisedUrls();
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
  });
});

describe("配对握手 + 加密命令全链路", () => {
  it("pair → snapshot → create/prompt/abort → 事件广播", async () => {
    const phone = generateBoxKeyPair();
    const client = await TestClient.connect(wsUrl());
    try {
      // 1) OTP 配对握手
      const { otp } = server.regeneratePairing();
      const helloC = secretboxEncrypt(
        JSON.stringify({ publicKey: phone.publicKey, name: "集成测试机" }),
        deriveOtpKey(otp),
      );
      client.send({ t: "pair", otp, c: helloC });
      const ack = (await client.waitFor((f) => (f as { t?: string }).t === "pair_ack")) as {
        ok: boolean;
        c: string;
      };
      expect(ack.ok).toBe(true);
      const desktopPk = pairing.getIdentity().publicKey;
      const ackInner = JSON.parse(boxDecrypt(ack.c, desktopPk, phone.secretKey)!) as {
        desktopPk: string;
        deviceId: string;
      };
      expect(ackInner.desktopPk).toBe(desktopPk);

      // 2) 配对成功后收到加密的全量快照（服务端出站 seq=0）
      const snapFrame = (await client.waitFor((f) => (f as { t?: string }).t === "encrypted")) as {
        seq: number;
        c: string;
      };
      expect(snapFrame.seq).toBe(0);
      const snap = JSON.parse(boxDecrypt(snapFrame.c, desktopPk, phone.secretKey)!) as {
        kind: string;
        event: { type: string; sessions: unknown[] };
      };
      expect(snap).toMatchObject({ kind: "event", event: { type: "session.snapshot", sessions: [] } });

      // 3) 加密命令：create → prompt → abort（手机端入站 seq 从 0 单调递增）
      const sendCmd = (seq: number, id: string, command: unknown) =>
        client.send({
          id,
          seq,
          t: "encrypted",
          c: boxEncrypt(JSON.stringify({ kind: "command", command }), desktopPk, phone.secretKey),
        });
      const decryptPayload = (f: unknown) => {
        const fr = f as { t?: string; c?: string };
        if (fr.t !== "encrypted" || !fr.c) return null;
        const plain = boxDecrypt(fr.c, desktopPk, phone.secretKey);
        return plain ? (JSON.parse(plain) as { kind: string; id?: string; ok?: boolean; data?: unknown }) : null;
      };

      sendCmd(0, "cmd-create", { type: "session.create", mode: "chat", prompt: "集成测试会话" });
      const createResp = (await client.waitFor((f) => decryptPayload(f)?.id === "cmd-create").then(decryptPayload))!;
      expect(createResp.ok).toBe(true);
      const sessionId = (createResp.data as { sessionId: string }).sessionId;
      expect(sessionId).toBeTruthy();

      sendCmd(1, "cmd-prompt", { type: "session.prompt", sessionId, text: "继续" });
      const promptResp = (await client.waitFor((f) => decryptPayload(f)?.id === "cmd-prompt").then(decryptPayload))!;
      expect(promptResp.ok).toBe(true);

      sendCmd(2, "cmd-abort", { type: "session.abort", sessionId });
      const abortResp = (await client.waitFor((f) => decryptPayload(f)?.id === "cmd-abort").then(decryptPayload))!;
      expect(abortResp.ok).toBe(true);

      // bridge 调用契约：create → prompt ×2 → abort
      expect(bridgeCalls.map((c) => c.type)).toEqual(["session.create", "session.prompt", "session.prompt", "session.abort"]);
      expect(registryEntries.get(sessionId)?.title).toBe("集成测试会话");

      // 4) 事件广播：bridge 事件 → 聚合器 → 加密帧
      for (const l of bridgeListeners) {
        l({ type: "session.event", sessionId, event: { type: "agent_start" } });
      }
      const statusPayload = (await client
        .waitFor((f) => decryptPayload(f)?.kind === "event")
        .then(decryptPayload)) as { kind: string; event: { type: string } };
      // 收到的第一个事件可能是别的，轮询直到 status running
      await client.waitFor((f) => {
        const p = decryptPayload(f);
        return p?.kind === "event" && (p as { event?: { type?: string } }).event?.type === "session.status";
      });
      void statusPayload;
    } finally {
      client.close();
    }
  });

  it("seq 重放 → 直接断开连接", async () => {
    const phone = generateBoxKeyPair();
    const client = await TestClient.connect(wsUrl());
    const { otp } = server.regeneratePairing();
    const helloC = secretboxEncrypt(JSON.stringify({ publicKey: phone.publicKey, name: "重放机" }), deriveOtpKey(otp));
    client.send({ t: "pair", otp, c: helloC });
    await client.waitFor((f) => (f as { t?: string }).t === "pair_ack");
    const desktopPk = pairing.getIdentity().publicKey;

    const frame = {
      id: "cmd-list",
      seq: 0,
      t: "encrypted",
      c: boxEncrypt(JSON.stringify({ kind: "command", command: { type: "session.list" } }), desktopPk, phone.secretKey),
    };
    client.send(frame);
    await client.waitFor((f) => {
      const fr = f as { t?: string; seq?: number };
      return fr.t === "encrypted" && fr.seq === 1; // 响应帧（snapshot 是 0）
    });
    client.send(frame); // 同样的 seq=0 重放
    await client.waitClosed();
  });

  it("auth：已配对设备凭公钥重连；未知公钥被拒并断开", async () => {
    // 先配对一台设备
    const phone = generateBoxKeyPair();
    const c1 = await TestClient.connect(wsUrl());
    const { otp } = server.regeneratePairing();
    c1.send({
      t: "pair",
      otp,
      c: secretboxEncrypt(JSON.stringify({ publicKey: phone.publicKey, name: "回头客" }), deriveOtpKey(otp)),
    });
    await c1.waitFor((f) => (f as { t?: string }).t === "pair_ack");
    c1.close();

    // 重连：auth 通过 + 收到快照
    const c2 = await TestClient.connect(wsUrl());
    c2.send({ t: "auth", publicKey: phone.publicKey });
    const ack = (await c2.waitFor((f) => (f as { t?: string }).t === "auth_ack")) as { ok: boolean };
    expect(ack.ok).toBe(true);
    await c2.waitFor((f) => (f as { t?: string }).t === "encrypted"); // snapshot
    c2.close();

    // 未知公钥：auth_ack ok:false 且断开
    const stranger = generateBoxKeyPair();
    const c3 = await TestClient.connect(wsUrl());
    c3.send({ t: "auth", publicKey: stranger.publicKey });
    const deny = (await c3.waitFor((f) => (f as { t?: string }).t === "auth_ack")) as { ok: boolean };
    expect(deny.ok).toBe(false);
    await c3.waitClosed();
  });

  it("首帧不是合法 hello → 断开", async () => {
    const client = await TestClient.connect(wsUrl());
    client.send({ t: "encrypted", id: "x", seq: 0, c: "aaaa" });
    await client.waitClosed();
  });
});
