/**
 * Web Push 服务端测试（M2 收尾，mock web-push）：
 * - VAPID 首次生成 0600 原子落盘、重载读回同一密钥对、setVapidDetails 接线；
 * - push.subscribe 按 deviceId 存储/覆盖、非法订阅拒绝、吊销设备删除订阅；
 * - 触发推送：pushEnabled 开关、payload 无任务数据、404/410 清理失效订阅、失败不影响主流程；
 * - 全链路：配对设备经加密帧 push.subscribe → PushService 存储。
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type HostCommand, type HostEvent, type ScheduleTask } from "@spcode/shared";
import { setLocale } from "@spcode/shared/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn<(sub: unknown, payload?: string) => Promise<void>>(),
  generateVAPIDKeys: vi.fn(() => ({ publicKey: "BMockPub", privateKey: "MockPriv" })),
  setVapidDetails: vi.fn(),
}));

vi.mock("web-push", () => ({ default: mocks }));

const { sendNotification, generateVAPIDKeys, setVapidDetails } = mocks;

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
import { TailscaleManager } from "../src/main/remote/transport/tailscale.js";
import type { RegistryLike } from "../src/main/session-helpers.js";
import type { SessionRegistryEntry } from "../src/main/session-registry.js";

const VALID_SUB = {
  endpoint: "https://push.example.com/sub/abc",
  keys: { p256dh: "p256dh-key", auth: "auth-secret" },
};

let dir = "";

beforeEach(() => {
  setLocale("zh-CN");
  dir = mkdtempSync(join(tmpdir(), "spcode-remote-push-"));
  sendNotification.mockReset().mockResolvedValue(undefined);
  generateVAPIDKeys.mockClear();
  setVapidDetails.mockClear();
});

afterEach(() => {
  setLocale("zh-CN");
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("VAPID 密钥对", () => {
  it("首次生成并 0600 原子落盘；新实例读回同一密钥对；setVapidDetails 以仓库地址接线", () => {
    const push = new PushService({ baseDir: dir });
    const keys = push.ensureVapid();
    expect(keys).toEqual({ publicKey: "BMockPub", privateKey: "MockPriv" });
    expect(generateVAPIDKeys).toHaveBeenCalledTimes(1);
    expect(setVapidDetails).toHaveBeenCalledWith("https://github.com/spcodhu/Spcode", "BMockPub", "MockPriv");

    const file = join(dir, "remote", "vapid.json");
    // Windows 无 POSIX 权限位，0600 断言仅 Unix 生效
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }

    // 新实例读回同一密钥对（不重新生成）
    const push2 = new PushService({ baseDir: dir });
    expect(push2.ensureVapid()).toEqual(keys);
    expect(generateVAPIDKeys).toHaveBeenCalledTimes(1);
  });
});

describe("push.subscribe 订阅存储", () => {
  it("按 deviceId 存储/覆盖；新实例可读回；非法订阅抛错", () => {
    const push = new PushService({ baseDir: dir });
    push.subscribe("dev-1", VALID_SUB);
    expect(push.subscriptionCount()).toBe(1);

    // 覆盖同设备
    const sub2 = { endpoint: "https://push.example.com/sub/def", keys: { p256dh: "k2", auth: "a2" } };
    push.subscribe("dev-1", sub2);
    expect(push.subscriptionCount()).toBe(1);

    // 新实例从磁盘读回（覆盖后的值）
    const push2 = new PushService({ baseDir: dir });
    expect(push2.subscriptionCount()).toBe(1);

    // 非法订阅：缺 keys / endpoint 非 https
    expect(() => push.subscribe("dev-2", { endpoint: "http://insecure.example.com", keys: VALID_SUB.keys })).toThrow();
    expect(() => push.subscribe("dev-2", { endpoint: VALID_SUB.endpoint })).toThrow();
    expect(push.subscriptionCount()).toBe(1);
  });

  it("unsubscribeDevice 删除订阅（吊销设备路径）", () => {
    const push = new PushService({ baseDir: dir });
    push.subscribe("dev-1", VALID_SUB);
    push.subscribe("dev-2", { ...VALID_SUB, endpoint: "https://push.example.com/sub/2" });
    push.unsubscribeDevice("dev-1");
    expect(push.subscriptionCount()).toBe(1);
    push.unsubscribeDevice("ghost"); // 不存在：空操作不抛错
    expect(push.subscriptionCount()).toBe(1);
  });
});

describe("触发推送", () => {
  const permissionEvent: HostEvent = {
    type: "permission.request",
    request: {
      requestId: "r1",
      sessionId: "s1",
      toolName: "Bash",
      args: { command: "rm -rf /secret-project" },
      risk: "danger",
    },
  };

  it("uses the current locale for each mocked send on an existing service", async () => {
    const push = new PushService({ baseDir: dir });
    push.subscribe("dev-1", VALID_SUB);
    await push.notifyForHostEvent(permissionEvent, true);
    expect(JSON.parse(sendNotification.mock.calls.at(-1)![1]!).body).toBe("有权限请求待处理");
    setLocale("en");
    await push.notifyForHostEvent(permissionEvent, true);
    expect(JSON.parse(sendNotification.mock.calls.at(-1)![1]!).body).toBe(
      "A permission request is waiting for approval",
    );
    await push.notifyForHostEvent(
      { type: "question.request", request: { requestId: "q", sessionId: "s", questions: [] } },
      true,
    );
    expect(JSON.parse(sendNotification.mock.calls.at(-1)![1]!).body).toBe("A question is waiting for your reply");
    await push.notifyForHostEvent({ type: "schedule.fired", taskId: "t", sessionId: "s", name: "PRIVATE_TASK" }, true);
    expect(JSON.parse(sendNotification.mock.calls.at(-1)![1]!).body).toBe("A scheduled task has started");
    expect(() => push.subscribe("bad", {})).toThrow("Invalid push subscription");
    for (const [, payload] of sendNotification.mock.calls) {
      expect(payload).not.toContain("PRIVATE_TASK");
      expect(payload).not.toContain("/secret-project");
    }
  });

  it("pushEnabled=false 时不发送", async () => {
    const push = new PushService({ baseDir: dir });
    push.subscribe("dev-1", VALID_SUB);
    await push.notifyForHostEvent(permissionEvent, false);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("permission.request → 无内容文案，payload 不含任何任务数据", async () => {
    const push = new PushService({ baseDir: dir });
    push.subscribe("dev-1", VALID_SUB);
    await push.notifyForHostEvent(permissionEvent, true);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [sub, payload] = sendNotification.mock.calls[0]!;
    expect(sub).toEqual(VALID_SUB);
    const body = JSON.parse(payload!) as { title: string; body: string };
    expect(body.title).toBe("Spcod");
    expect(body.body).toBe("有权限请求待处理");
    // 不泄露工具名/命令/会话 id
    expect(payload).not.toContain("rm -rf");
    expect(payload).not.toContain("Bash");
    expect(payload).not.toContain("s1");
  });

  it("question.request / schedule.fired 同样推送无内容文案；无关事件不推", async () => {
    const push = new PushService({ baseDir: dir });
    push.subscribe("dev-1", VALID_SUB);
    await push.notifyForHostEvent(
      { type: "question.request", request: { requestId: "q1", sessionId: "s1", questions: [] } },
      true,
    );
    await push.notifyForHostEvent({ type: "schedule.fired", taskId: "t1", name: "晨报", sessionId: "s2" }, true);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    for (const call of sendNotification.mock.calls) {
      expect(call[1]).not.toContain("晨报");
    }
    await push.notifyForHostEvent({ type: "sessions.changed" }, true);
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it("404/410 删除失效订阅；其他错误保留且不影响主流程", async () => {
    const push = new PushService({ baseDir: dir });
    push.subscribe("gone", VALID_SUB);
    push.subscribe("broken", { ...VALID_SUB, endpoint: "https://push.example.com/sub/broken" });
    push.subscribe("fine", { ...VALID_SUB, endpoint: "https://push.example.com/sub/fine" });
    sendNotification.mockImplementation(async (sub) => {
      const endpoint = (sub as { endpoint: string }).endpoint;
      if (endpoint.endsWith("/abc")) throw Object.assign(new Error("gone"), { statusCode: 410 });
      if (endpoint.endsWith("/broken")) throw Object.assign(new Error("bad gateway"), { statusCode: 500 });
    });
    // 不抛出
    await push.notifyForHostEvent(permissionEvent, true);
    expect(push.subscriptionCount()).toBe(2); // gone 被删，broken/fine 保留
    // 持久化也同步删除
    expect(new PushService({ baseDir: dir }).subscriptionCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 全链路：配对设备经加密帧 push.subscribe → PushService 按 deviceId 存储
// ---------------------------------------------------------------------------

describe("RemoteServer 集成：push.subscribe 命令", () => {
  it("加密命令注册订阅到配对设备名下；remote.hello 携带 VAPID 公钥", async () => {
    const pairing = new PairingManager({ baseDir: dir });
    const push = new PushService({ baseDir: dir });
    const transport = new LanTransport({ port: 0, staticDir: join(dir, "pwa-not-built") });
    const registryEntries = new Map<string, SessionRegistryEntry>();
    const registry: RegistryLike = {
      list: () => [...registryEntries.values()],
      get: (id) => registryEntries.get(id),
      upsert: (entry) => void registryEntries.set(entry.id, entry),
      patch: () => {},
      remove: (id) => void registryEntries.delete(id),
    };
    const bridge = {
      onEvent: () => () => {},
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
    const settings = {
      get: () => ({
        ...DEFAULT_SETTINGS,
        remote: { enabled: true, port: 0, relayUrl: null, tailscale: false, pushEnabled: true },
      }),
    };
    const tailscale = new TailscaleManager({ run: async () => ({ code: 0, stdout: "", stderr: "" }) });
    const server = new RemoteServer({ settings, bridge, scheduler, registry, pairing, transport, push, tailscale });
    await server.start();
    const port = transport.getPort();

    try {
      const phone = generateBoxKeyPair();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const frames: { t?: string; c?: string }[] = [];
      ws.on("message", (data: Buffer) => frames.push(JSON.parse(data.toString())));
      await new Promise<void>((r) => ws.on("open", () => r()));

      const { otp } = server.regeneratePairing();
      ws.send(
        JSON.stringify({
          t: "pair",
          otp,
          c: secretboxEncrypt(JSON.stringify({ publicKey: phone.publicKey, name: "推送机" }), deriveOtpKey(otp)),
        }),
      );
      const desktopPk = pairing.getIdentity().publicKey;
      const waitFrame = async (pred: (f: { t?: string; c?: string }) => boolean) => {
        for (let i = 0; i < 300; i++) {
          const hit = frames.find(pred);
          if (hit) return hit;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("waitFrame 超时");
      };
      await waitFrame((f) => f.t === "pair_ack");

      // remote.hello 携带 VAPID 公钥（mock 值）
      const helloFrame = await waitFrame((f) => {
        if (f.t !== "encrypted" || !f.c) return false;
        const plain = boxDecrypt(f.c, desktopPk, phone.secretKey);
        if (!plain) return false;
        const p = JSON.parse(plain) as { kind: string; event?: { type?: string } };
        return p.kind === "event" && p.event?.type === "remote.hello";
      });
      const helloPlain = JSON.parse(boxDecrypt(helloFrame.c!, desktopPk, phone.secretKey)!) as {
        event: { vapidPublicKey: string };
      };
      expect(helloPlain.event.vapidPublicKey).toBe("BMockPub");

      // push.subscribe 加密命令
      ws.send(
        JSON.stringify({
          id: "cmd-sub",
          seq: 0,
          t: "encrypted",
          c: boxEncrypt(
            JSON.stringify({ kind: "command", command: { type: "push.subscribe", subscription: VALID_SUB } }),
            desktopPk,
            phone.secretKey,
          ),
        }),
      );
      const respFrame = await waitFrame((f) => {
        if (f.t !== "encrypted" || !f.c) return false;
        const plain = boxDecrypt(f.c, desktopPk, phone.secretKey);
        if (!plain) return false;
        const p = JSON.parse(plain) as { kind: string; id?: string };
        return p.kind === "response" && p.id === "cmd-sub";
      });
      const resp = JSON.parse(boxDecrypt(respFrame.c!, desktopPk, phone.secretKey)!) as { ok: boolean };
      expect(resp.ok).toBe(true);
      expect(push.subscriptionCount()).toBe(1);
      ws.close();
    } finally {
      await server.stop();
      await transport.stop();
    }
  });
});
