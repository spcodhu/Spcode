/** 认证快照协议：宿主事件镜像 → RemoteServer 加密快照，含重连后的权威对账。 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  type HostCommand,
  type HostEvent,
  type RemoteEncryptedPayload,
  type ScheduleTask,
  type SessionMeta,
} from "@spcode/shared";
import { afterEach, describe, expect, it } from "vitest";
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
import { RemoteRuntimeTracker } from "../src/main/remote/runtime-snapshot.js";
import type { PeerConnection, RemoteTransport } from "../src/main/remote/transport/types.js";
import type { RegistryLike } from "../src/main/session-helpers.js";

const meta: SessionMeta = {
  id: "s1",
  mode: "chat",
  cwd: "",
  title: "快照会话",
  model: null,
  thinkingLevel: "medium",
  sessionFile: null,
  createdAt: 1,
  updatedAt: 2,
};
const permission = {
  requestId: "p1",
  sessionId: "s1",
  toolName: "bash",
  args: { command: "pwd" },
  risk: "write" as const,
};
const question = {
  requestId: "q1",
  sessionId: "s1",
  questions: [{ question: "继续吗？" }],
};

class FakeTransport implements RemoteTransport {
  private listener: ((peer: PeerConnection) => void) | null = null;
  onConnection(cb: (peer: PeerConnection) => void): void {
    this.listener = cb;
  }
  connect(peer: PeerConnection): void {
    this.listener?.(peer);
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getAdvertisedUrls(): string[] {
    return [];
  }
}

class FakePeer implements PeerConnection {
  readonly id = "peer-1";
  readonly sent: unknown[] = [];
  private onMessageCallback: ((frame: unknown) => void) | null = null;
  private onCloseCallback: (() => void) | null = null;
  send(frame: unknown): void {
    this.sent.push(frame);
  }
  onMessage(cb: (frame: unknown) => void): void {
    this.onMessageCallback = cb;
  }
  onClose(cb: () => void): void {
    this.onCloseCallback = cb;
  }
  receive(frame: unknown): void {
    this.onMessageCallback?.(frame);
  }
  close(): void {
    this.onCloseCallback?.();
  }
}

function emitTo(listeners: Set<(event: HostEvent) => void>, event: HostEvent): void {
  for (const listener of listeners) listener(event);
}

function decryptedEvents(peer: FakePeer, desktopPk: string, phoneSecret: string): RemoteEncryptedPayload[] {
  return peer.sent.flatMap((raw) => {
    const frame = raw as { t?: string; c?: string };
    if (frame.t !== "encrypted" || !frame.c) return [];
    const plain = boxDecrypt(frame.c, desktopPk, phoneSecret);
    return plain ? [JSON.parse(plain) as RemoteEncryptedPayload] : [];
  });
}

describe("RemoteRuntimeTracker", () => {
  it("推导 running/waiting，结清请求并在 fatal/删除后清理陈旧状态", () => {
    const tracker = new RemoteRuntimeTracker();
    tracker.handle({ type: "session.event", sessionId: "s1", event: { type: "agent_start" } });
    expect(tracker.snapshot([meta]).sessions[0]?.status).toBe("running");
    tracker.handle({ type: "permission.request", request: permission });
    tracker.handle({ type: "question.request", request: question });
    expect(tracker.snapshot([meta])).toMatchObject({
      sessions: [{ id: "s1", status: "waiting_permission" }],
      pendingPermissions: [permission],
      pendingQuestions: [question],
    });
    tracker.handle({ type: "permission.resolved", requestId: "p1", approved: true, by: "local" });
    expect(tracker.snapshot([meta]).sessions[0]?.status).toBe("running");
    tracker.handle({ type: "session.event", sessionId: "s1", event: { type: "agent_settled" } });
    expect(tracker.snapshot([meta])).toMatchObject({
      sessions: [{ id: "s1", status: "idle" }],
      pendingPermissions: [],
      pendingQuestions: [],
    });

    tracker.handle({ type: "session.event", sessionId: "gone", event: { type: "agent_start" } });
    tracker.handle({ type: "permission.request", request: { ...permission, requestId: "global", sessionId: "" } });
    tracker.handle({ type: "permission.request", request: { ...permission, requestId: "deleted", sessionId: "gone" } });
    const reconciled = tracker.snapshot([meta]);
    expect(reconciled.pendingPermissions.map((request) => request.requestId)).toEqual(["global"]);

    tracker.handle({ type: "session.event", sessionId: "s1", event: { type: "agent_start" } });
    tracker.handle({ type: "question.request", request: question });
    tracker.handle({ type: "host.error", message: "dead", fatal: true });
    expect(tracker.snapshot([meta])).toMatchObject({
      sessions: [{ id: "s1", status: "idle" }],
      pendingPermissions: [],
      pendingQuestions: [],
    });
  });
});

describe("RemoteServer 认证快照协议", () => {
  let dir = "";
  let server: RemoteServer | null = null;
  let transport: FakeTransport | null = null;

  afterEach(async () => {
    await server?.stop();
    await transport?.stop();
    server = null;
    transport = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("pair 与后续 auth 都携带状态/权限/提问，重连快照替换已结清状态", async () => {
    dir = mkdtempSync(join(tmpdir(), "spcode-remote-snapshot-"));
    const pairing = new PairingManager({ baseDir: dir });
    const listeners = new Set<(event: HostEvent) => void>();
    const entries = new Map([[meta.id, meta]]);
    const registry: RegistryLike = {
      list: () => [...entries.values()],
      get: (id) => entries.get(id),
      upsert: (entry) => void entries.set(entry.id, entry),
      patch: (id, patch) => {
        const current = entries.get(id);
        if (current) entries.set(id, { ...current, ...patch, id });
      },
      remove: (id) => void entries.delete(id),
    };
    const bridge = {
      onEvent(cb: (event: HostEvent) => void) {
        listeners.add(cb);
        return () => listeners.delete(cb);
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
      runNow: async () => "unused",
    };
    transport = new FakeTransport();
    server = new RemoteServer({
      settings: { get: () => ({ ...DEFAULT_SETTINGS, remote: { ...DEFAULT_SETTINGS.remote, enabled: true } }) },
      bridge,
      scheduler,
      registry,
      pairing,
      transport,
      push: new PushService({ baseDir: dir }),
    });

    // 构造后、start 前的事件也必须进入认证快照。
    emitTo(listeners, { type: "session.event", sessionId: "s1", event: { type: "agent_start" } });
    emitTo(listeners, { type: "permission.request", request: permission });
    emitTo(listeners, { type: "question.request", request: question });
    await server.start();

    const phone = generateBoxKeyPair();
    const first = new FakePeer();
    transport.connect(first);
    const { otp } = server.regeneratePairing();
    first.receive({
      t: "pair",
      c: secretboxEncrypt(JSON.stringify({ publicKey: phone.publicKey, name: "快照机" }), deriveOtpKey(otp)),
    });
    const firstSnapshot = decryptedEvents(first, pairing.getIdentity().publicKey, phone.secretKey).find(
      (payload) => payload.kind === "event" && payload.event.type === "session.snapshot",
    );
    expect(firstSnapshot).toMatchObject({
      kind: "event",
      event: {
        type: "session.snapshot",
        sessions: [{ id: "s1", status: "waiting_permission" }],
        pendingPermissions: [permission],
        pendingQuestions: [question],
      },
    });

    emitTo(listeners, { type: "permission.resolved", requestId: "p1", approved: true, by: "local" });
    emitTo(listeners, { type: "question.resolved", requestId: "q1" });
    emitTo(listeners, { type: "session.event", sessionId: "s1", event: { type: "agent_settled" } });

    const second = new FakePeer();
    transport.connect(second);
    second.receive({ t: "auth", publicKey: phone.publicKey, nextSeq: 0 });
    const challenge = second.sent.find((frame) => (frame as { t?: string }).t === "auth_challenge") as {
      nonce: string;
    };
    second.receive({
      t: "auth_proof",
      c: boxEncrypt(challenge.nonce, pairing.getIdentity().publicKey, phone.secretKey),
    });
    const secondSnapshot = decryptedEvents(second, pairing.getIdentity().publicKey, phone.secretKey).find(
      (payload) => payload.kind === "event" && payload.event.type === "session.snapshot",
    );
    expect(secondSnapshot).toMatchObject({
      kind: "event",
      event: {
        type: "session.snapshot",
        sessions: [{ id: "s1", status: "idle" }],
        pendingPermissions: [],
        pendingQuestions: [],
      },
    });
  });
});
