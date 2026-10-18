/**
 * RemoteClient 的 relay 通道行为单测（FakeWebSocket 驱动，不起真实服务）：
 * - 连接 URL 走 /channel/<channelId>?role=device；
 * - auth / encrypted 帧外层带 deviceId；
 * - 入站帧：deviceId 不匹配的丢弃、relay 控制帧忽略、解不开的丢弃（不断连）；
 * - 他设备的 auth_ack 不误判；
 * - 重连后出站 seq 归零、入站 SeqGuard 重置（桌面出站 seq 不归零也兼容）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConnectionState, RemoteClient } from "../src/lib/client";
import { generateKeyPair, sealPayload } from "../src/lib/crypto";
import type { PairingRecord } from "../src/lib/db";
import type { RemoteEventExt } from "../src/lib/protocol";
import { deriveChannelId } from "../src/lib/relay";

type Listener = (ev: { data?: string }) => void;

class FakeWs {
  static instances: FakeWs[] = [];
  readonly url: string;
  readonly sent: string[] = [];
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeWs.instances.push(this);
  }

  addEventListener(type: string, cb: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: Listener): void {
    this.listeners.get(type)?.delete(cb);
  }

  send(data: string): void {
    this.sent.push(String(data));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", {});
  }

  // --- 测试驱动 ---
  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  private emit(type: string, ev: { data?: string }): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb(ev);
  }
}

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const desktop = generateKeyPair();
const phone = generateKeyPair();

function relayRecord(): PairingRecord {
  return {
    version: 1,
    desktopPk: desktop.publicKey,
    deviceId: "dev-1",
    hosts: ["relay+wss://relay.test"],
    deviceName: "单测手机",
    keyPair: phone,
    pairedAt: Date.now(),
  };
}

/** 桌面视角加密一帧载荷（phone 公钥 × desktop 私钥） */
function fromDesktop(payload: unknown): string {
  return sealPayload(payload as never, phone.publicKey, desktop.secretKey);
}

describe("RemoteClient：relay 通道", () => {
  let client: RemoteClient;
  let events: RemoteEventExt[];
  let states: ConnectionState[];

  beforeEach(() => {
    FakeWs.instances = [];
    events = [];
    states = [];
    vi.stubGlobal("WebSocket", FakeWs as unknown as typeof WebSocket);
  });

  afterEach(() => {
    client?.stop();
    vi.unstubAllGlobals();
  });

  async function startToReady(): Promise<FakeWs> {
    client = new RemoteClient(
      relayRecord(),
      { onEvent: (e) => events.push(e), onState: (s) => states.push(s) },
      {
        backoffMinMs: 20,
        backoffMaxMs: 40,
      },
    );
    client.start();
    await tick();
    const ws = FakeWs.instances.at(-1)!;
    ws.open();
    await tick();
    return ws;
  }

  async function ackAuth(ws: FakeWs): Promise<void> {
    ws.message({ t: "auth_ack", ok: true, desktopPk: desktop.publicKey, deviceId: "dev-1" });
    await tick();
  }

  it("连接 URL 走 channel 路径；auth 与加密帧外层带 deviceId", async () => {
    const ws = await startToReady();
    expect(ws.url).toBe(`wss://relay.test/channel/${deriveChannelId(desktop.publicKey)}?role=device`);

    const auth = JSON.parse(ws.sent[0]!);
    expect(auth).toEqual({ t: "auth", publicKey: phone.publicKey, deviceId: "dev-1" });

    await ackAuth(ws);
    expect(states).toContain("ready");

    void client.command({ type: "session.list" }).catch(() => {});
    await tick();
    const frame = JSON.parse(ws.sent[1]!);
    expect(frame).toMatchObject({ t: "encrypted", seq: 0, deviceId: "dev-1" });
    expect(typeof frame.c).toBe("string");
  });

  it("relay 控制帧与他设备 auth_ack 不干扰握手", async () => {
    const ws = await startToReady();
    ws.message({ t: "relay.hello", role: "device", queued: 0 });
    ws.message({ t: "relay.error", error: "channel_full" });
    ws.message({ t: "auth_ack", ok: false, error: "unknown_device", deviceId: "other-dev" }); // 他设备的，不该误判
    await tick();
    expect(states).not.toContain("unpaired");
    await ackAuth(ws);
    expect(states).toContain("ready");
  });

  it("入站帧过滤：deviceId 不匹配丢弃（不占 seq）；解不开的丢弃不断连", async () => {
    const ws = await startToReady();
    await ackAuth(ws);

    // 他设备的帧：即使内容合法也应丢弃，且不影响本设备 SeqGuard
    ws.message({
      id: "a",
      seq: 0,
      t: "encrypted",
      deviceId: "other-dev",
      c: fromDesktop({ kind: "event", event: { type: "sessions.changed" } }),
    });
    await tick();
    expect(events).toHaveLength(0);

    // 本设备合法帧 seq 0 → 正常投递（上一个他设备帧没有占用 seq）
    ws.message({
      id: "b",
      seq: 0,
      t: "encrypted",
      deviceId: "dev-1",
      c: fromDesktop({ kind: "event", event: { type: "sessions.changed" } }),
    });
    await tick();
    expect(events.map((e) => e.type)).toEqual(["sessions.changed"]);

    // 解不开的帧（带本设备 deviceId）：丢弃，不断连、SeqGuard 不动
    ws.message({ id: "c", seq: 1, t: "encrypted", deviceId: "dev-1", c: "AAAA" });
    await tick();
    expect(ws.closed).toBe(false);
    ws.message({
      id: "d",
      seq: 1,
      t: "encrypted",
      deviceId: "dev-1",
      c: fromDesktop({ kind: "event", event: { type: "sessions.changed" } }),
    });
    await tick();
    expect(events).toHaveLength(2);
    expect(ws.closed).toBe(false);
  });

  it("重连后重新 auth：出站 seq 归零、入站 SeqGuard 重置（兼容桌面出站不归零）", async () => {
    const ws1 = await startToReady();
    await ackAuth(ws1);
    // 第一条连接上桌面出站推进到 seq 5
    ws1.message({
      id: "x",
      seq: 5,
      t: "encrypted",
      deviceId: "dev-1",
      c: fromDesktop({ kind: "event", event: { type: "sessions.changed" } }),
    });
    await tick();
    expect(events).toHaveLength(1);
    void client.command({ type: "session.list" }).catch(() => {});
    await tick();
    expect(JSON.parse(ws1.sent[1]!).seq).toBe(0);

    // 断线 → 自动重连（退避 20ms）
    ws1.close();
    await tick(60);
    const ws2 = FakeWs.instances.at(-1)!;
    expect(ws2).not.toBe(ws1);
    ws2.open();
    await tick();
    expect(JSON.parse(ws2.sent[0]!)).toMatchObject({ t: "auth", deviceId: "dev-1" });
    await ackAuth(ws2);

    // 出站 seq 从新连接 0 起算
    void client.command({ type: "session.list" }).catch(() => {});
    await tick();
    expect(JSON.parse(ws2.sent[1]!).seq).toBe(0);

    // 入站 SeqGuard 已重置：桌面出站 seq 不归零（继续 6）也能正常接收
    ws2.message({
      id: "y",
      seq: 6,
      t: "encrypted",
      deviceId: "dev-1",
      c: fromDesktop({ kind: "event", event: { type: "sessions.changed" } }),
    });
    await tick();
    expect(events).toHaveLength(2);
    expect(ws2.closed).toBe(false);
  });
});
