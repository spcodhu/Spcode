/**
 * RemoteClient 的 relay 通道行为单测（FakeWebSocket 驱动，不起真实服务）：
 * - 连接 URL 走 /channel/<channelId>?role=device；
 * - auth / auth_proof / encrypted 帧外层带 deviceId（协议 v2：挑战-应答 + 出站 seq 跨连接持久续接）；
 * - 入站帧：deviceId 不匹配的丢弃、relay 控制帧忽略、解不开的丢弃（不断连）；
 * - 他设备的 auth_ack 不误判；
 * - 重连后出站 seq 持久续接不归零、入站 SeqGuard 重置（桌面出站 seq 不归零也兼容）。
 */

import type { RelayDeviceGrant, RemoteEvent as RemoteEventExt } from "@spcode/shared";
import { b64encode, boxDecrypt, generateBoxKeyPair, sealJson, sealPayload } from "@spcode/shared/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConnectionState, PairError, pairWithQr, RemoteClient } from "../src/lib/client";
import type { PairingRecord } from "../src/lib/db";
import { deriveChannelId } from "../src/lib/relay";

const mocks = vi.hoisted(() => ({ savePairing: vi.fn() }));
vi.mock("../src/lib/db", () => ({ savePairing: mocks.savePairing }));

type Listener = (ev: { data?: string }) => void;

class FakeWs {
  static instances: FakeWs[] = [];
  static steps: string[] = [];
  readonly url: string;
  readonly sent: string[] = [];
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeWs.steps.push("ws");
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

const desktop = generateBoxKeyPair();
const phone = generateBoxKeyPair();

function grant(exp = Date.now() + 60_000): RelayDeviceGrant {
  return { exp, mac: b64encode(new Uint8Array(32).fill(7)) };
}

function relayRecord(overrides: Partial<PairingRecord> = {}): PairingRecord {
  return {
    version: 2,
    desktopPk: desktop.publicKey,
    deviceId: "dev-1",
    hosts: ["relay+wss://relay.test"],
    deviceName: "单测手机",
    keyPair: phone,
    pairedAt: Date.now(),
    relayGrant: grant(),
    ...overrides,
  };
}

function lanRecord(version: 1 | 2 = 1): PairingRecord {
  return relayRecord({ version, hosts: ["http://lan.test"], relayGrant: undefined });
}

/** 桌面视角加密一帧载荷（phone 公钥 × desktop 私钥） */
function fromDesktop(payload: unknown): string {
  return sealPayload(payload as never, phone.publicKey, desktop.secretKey);
}

describe("RemoteClient：relay 通道", () => {
  let client: RemoteClient;
  let events: RemoteEventExt[];
  let states: ConnectionState[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeWs.instances = [];
    FakeWs.steps = [];
    events = [];
    states = [];
    mocks.savePairing.mockReset().mockResolvedValue(undefined);
    let ticketId = 0;
    fetchMock = vi.fn(async () => {
      FakeWs.steps.push("ticket");
      return new Response(JSON.stringify({ ticket: `ticket-${++ticketId}` }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWs as unknown as typeof WebSocket);
  });

  afterEach(() => {
    client?.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function startToReady(record: PairingRecord = relayRecord()): Promise<FakeWs> {
    client = new RemoteClient(
      record,
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

  /** 模拟桌面端协议 v3 认证：明文挑战 → 校验设备私钥证明 → sealJson 加密 ack */
  async function challenge(ws: FakeWs, nonce = `test-nonce-${Math.random().toString(36).slice(2)}`): Promise<void> {
    ws.message({ t: "auth_challenge", nonce, deviceId: "dev-1" });
    await tick();
    const proofFrame = JSON.parse(ws.sent.at(-1)!) as { t: string; c: string };
    expect(proofFrame.t).toBe("auth_proof");
    expect(boxDecrypt(proofFrame.c, phone.publicKey, desktop.secretKey)).toBe(nonce);
  }

  async function ackAuth(
    ws: FakeWs,
    options: { resumeSeq?: number; relayGrant?: RelayDeviceGrant } = {},
  ): Promise<void> {
    await challenge(ws);
    const inner = {
      desktopPk: desktop.publicKey,
      resumeSeq: options.resumeSeq ?? 0,
      ...(options.relayGrant ? { relayGrant: options.relayGrant } : {}),
    };
    ws.message({
      t: "auth_ack",
      ok: true,
      deviceId: "dev-1",
      c: sealJson(inner, phone.publicKey, desktop.secretKey),
    });
    await tick();
  }

  function encryptedAuthError(ws: FakeWs, error: string): void {
    ws.message({
      t: "auth_ack",
      ok: false,
      deviceId: "dev-1",
      c: sealJson({ error }, phone.publicKey, desktop.secretKey),
    });
  }

  it("连接 URL 走 channel 路径；auth 与加密帧外层带 deviceId", async () => {
    const record = relayRecord();
    const ws = await startToReady(record);
    expect(ws.url).toBe(
      `wss://relay.test/channel/${deriveChannelId(desktop.publicKey)}?role=device&device=dev-1&ticket=ticket-1`,
    );
    expect(FakeWs.steps.slice(0, 2)).toEqual(["ticket", "ws"]);
    const [, ticketInit] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(ticketInit?.body))).toMatchObject({
      role: "device",
      deviceId: "dev-1",
      hostPk: desktop.publicKey,
      grant: record.relayGrant,
    });

    const auth = JSON.parse(ws.sent[0]!);
    expect(auth).toEqual({ t: "auth", publicKey: phone.publicKey, deviceId: "dev-1", nextSeq: 0 });

    await ackAuth(ws);
    expect(states).toContain("ready");

    void client.command({ type: "session.list" }).catch(() => {});
    await tick();
    const frame = ws.sent
      .map((s) => JSON.parse(s) as { t?: string; seq?: number; deviceId?: string; c?: unknown })
      .find((f) => f.t === "encrypted")!;
    expect(frame).toMatchObject({ t: "encrypted", seq: 0, deviceId: "dev-1" });
    expect(typeof frame.c).toBe("string");
  });

  it("relay 控制帧与他设备 auth_ack 不干扰握手", async () => {
    const ws = await startToReady();
    ws.message({ t: "relay.hello", role: "device", queued: 0 });
    ws.message({ t: "relay.error", error: "channel_full" });
    ws.message({
      t: "auth_ack",
      ok: false,
      deviceId: "other-dev",
      c: sealJson({ error: "unknown_device" }, phone.publicKey, desktop.secretKey),
    });
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

  it("命令超时只拒绝当前 Promise，不自动重发结果未知的命令", async () => {
    const ws = await startToReady();
    await ackAuth(ws);
    const encryptedCount = () =>
      ws.sent.map((raw) => JSON.parse(raw) as { t?: string }).filter((frame) => frame.t === "encrypted").length;
    await expect(
      client.command({ type: "permission.reply", requestId: "unknown", approved: true }, 20),
    ).rejects.toThrow("命令响应超时");
    expect(encryptedCount()).toBe(1);
    await tick(60);
    expect(encryptedCount()).toBe(1);
  });

  it("stop 后迟到的 auth_ack 不得覆盖新连接的 connecting/ready 状态", async () => {
    const oldWs = await startToReady();
    oldWs.message({ t: "auth_challenge", nonce: "old-challenge", deviceId: "dev-1" });
    await tick();
    client.stop();
    client.start();
    await tick();
    const freshWs = FakeWs.instances.at(-1)!;
    expect(freshWs).not.toBe(oldWs);
    freshWs.open();
    await tick();

    oldWs.message({
      t: "auth_ack",
      ok: true,
      deviceId: "dev-1",
      c: sealJson({ desktopPk: desktop.publicKey, resumeSeq: 0 }, phone.publicKey, desktop.secretKey),
    });
    await tick();
    expect(states.at(-1)).toBe("connecting");
    expect(freshWs.closed).toBe(false);
    await ackAuth(freshWs);
    expect(states.at(-1)).toBe("ready");
  });

  it("重连后重新 auth：出站 seq 持久续接不归零、入站 SeqGuard 重置（兼容桌面出站不归零）", async () => {
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
    const firstCmd = ws1.sent
      .map((s) => JSON.parse(s) as { t?: string; seq?: number })
      .find((f) => f.t === "encrypted")!;
    expect(firstCmd.seq).toBe(0);

    // 断线 → 自动重连（退避 20ms）
    ws1.close();
    await tick(60);
    const ws2 = FakeWs.instances.at(-1)!;
    expect(ws2).not.toBe(ws1);
    ws2.open();
    await tick();
    // 协议 v2：出站 seq 持久续接（上条连接已发到 0，下一个应为 1），auth 携带 nextSeq 供 host 校验
    expect(JSON.parse(ws2.sent[0]!)).toMatchObject({ t: "auth", deviceId: "dev-1", nextSeq: 1 });
    await ackAuth(ws2);

    void client.command({ type: "session.list" }).catch(() => {});
    await tick();
    const secondCmd = ws2.sent
      .map((s) => JSON.parse(s) as { t?: string; seq?: number })
      .find((f) => f.t === "encrypted")!;
    expect(secondCmd.seq).toBe(1);

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

  it("伪造明文或解不开的 auth_ack 被忽略，超时后退避且不会 unpaired", async () => {
    vi.useFakeTimers();
    client = new RemoteClient(
      relayRecord(),
      { onEvent: (e) => events.push(e), onState: (s) => states.push(s) },
      { backoffMinMs: 20, backoffMaxMs: 40 },
    );
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWs.instances.at(-1)!;
    ws.open();
    await vi.advanceTimersByTimeAsync(0);

    ws.message({ t: "auth_ack", ok: false, error: "unknown_device", deviceId: "dev-1" });
    ws.message({ t: "auth_ack", ok: false, c: "not-decryptable", deviceId: "dev-1" });
    ws.message({
      t: "auth_ack",
      ok: true,
      desktopPk: desktop.publicKey,
      resumeSeq: 999,
      deviceId: "dev-1",
    });
    expect(states).not.toContain("unpaired");
    expect(states).not.toContain("ready");

    await vi.advanceTimersByTimeAsync(8000);
    expect(ws.closed).toBe(true);
    expect(states.at(-1)).toBe("reconnecting");
    expect(states).not.toContain("unpaired");
    await vi.advanceTimersByTimeAsync(20);
    expect(FakeWs.instances).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("v1 记录经 LAN auth 成功升级 v2，并持久化新 relayGrant", async () => {
    const record = lanRecord(1);
    const refreshed = grant(Date.now() + 7 * 24 * 3600_000);
    const ws = await startToReady(record);
    expect(fetchMock).not.toHaveBeenCalled();
    await ackAuth(ws, { relayGrant: refreshed });

    expect(client.getState()).toBe("ready");
    expect(record.version).toBe(2);
    expect(record.relayGrant).toEqual(refreshed);
    expect(mocks.savePairing).toHaveBeenCalledWith(record);
    expect(mocks.savePairing.mock.calls.at(-1)?.[0]).toMatchObject({ version: 2, relayGrant: refreshed });
  });

  it("relay-only 且 grant 过期进入 grant_expired，不取票也不建 WS", async () => {
    client = new RemoteClient(
      relayRecord({ relayGrant: grant(Date.now() - 1) }),
      { onEvent: (e) => events.push(e), onState: (s) => states.push(s) },
      { backoffMinMs: 20, backoffMaxMs: 40 },
    );
    client.start();
    await tick();
    expect(client.getState()).toBe("grant_expired");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeWs.instances).toHaveLength(0);
  });

  it("加密 unknown_device 进入 unpaired，不再重连", async () => {
    const ws = await startToReady();
    encryptedAuthError(ws, "unknown_device");
    await tick();
    expect(client.getState()).toBe("unpaired");
    expect(ws.closed).toBe(true);
    await tick(60);
    expect(FakeWs.instances).toHaveLength(1);
  });

  it("私钥证明后的加密 seq_rollback 进入 incompatible", async () => {
    const ws = await startToReady();
    await challenge(ws);
    encryptedAuthError(ws, "seq_rollback");
    await tick();
    expect(client.getState()).toBe("incompatible");
    expect(states).not.toContain("unpaired");
  });

  it("pair_ack ok:false 解不开则忽略并在超时后继续下一 host", async () => {
    vi.useFakeTimers();
    const hosts = "http://first.test,http://second.test";
    const qr = `spcode-remote://pair?v=4&hosts=${encodeURIComponent(hosts)}&desktop_pk=${encodeURIComponent(desktop.publicKey)}&otp=12345678`;
    const pending = pairWithQr(qr, "配对测试机");
    await vi.advanceTimersByTimeAsync(0);
    const first = FakeWs.instances.at(-1)!;
    first.open();
    await vi.advanceTimersByTimeAsync(0);
    const hello = JSON.parse(first.sent[0]!) as { t: string; v: number; pk: string; c: string };
    expect(hello).toMatchObject({ t: "pair", v: 3 });

    first.message({ t: "pair_ack", ok: false, c: "not-decryptable" });
    await vi.advanceTimersByTimeAsync(8000);
    const second = FakeWs.instances.at(-1)!;
    expect(second).not.toBe(first);
    expect(second.url).toBe("ws://second.test/ws");
    second.open();
    await vi.advanceTimersByTimeAsync(0);
    second.message({
      t: "pair_ack",
      ok: true,
      c: sealJson({ desktopPk: desktop.publicKey, deviceId: "paired-device" }, hello.pk, desktop.secretKey),
    });
    await expect(pending).resolves.toMatchObject({
      version: 2,
      desktopPk: desktop.publicKey,
      deviceId: "paired-device",
      hosts: hosts.split(","),
    });
  });

  it("可解密的 pair_ack 失败仍映射确定的 PairError", async () => {
    const qr = `spcode-remote://pair?v=4&hosts=${encodeURIComponent("http://only.test")}&desktop_pk=${encodeURIComponent(desktop.publicKey)}&otp=12345678`;
    const pending = pairWithQr(qr, "失败配对机");
    await tick();
    const ws = FakeWs.instances.at(-1)!;
    ws.open();
    await tick();
    const hello = JSON.parse(ws.sent[0]!) as { pk: string };
    ws.message({
      t: "pair_ack",
      ok: false,
      c: sealJson({ error: "otp_mismatch" }, hello.pk, desktop.secretKey),
    });
    await expect(pending).rejects.toBeInstanceOf(PairError);
    await expect(pending).rejects.toMatchObject({ code: "otp_mismatch" });
  });
});
