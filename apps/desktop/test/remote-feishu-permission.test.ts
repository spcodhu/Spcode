/**
 * 飞书通道单测（二）：RemoteEvent 出站映射与卡片回调全链路
 * （permission.request → 卡片 → 按钮回调 → bridge.replyPermission → permission.resolved 更新原卡片）、
 * question 卡片、完成摘要、schedule.fired，以及 RemoteServer 集成（状态透出脱敏）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type HostEvent, type PermissionRequest, type QuestionRequest } from "@spcode/shared";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteServer, type RemoteServerDeps } from "../src/main/remote/index.js";
import { PairingManager } from "../src/main/remote/pairing.js";
import type { TailscaleManager } from "../src/main/remote/transport/tailscale.js";
import {
  cardText,
  FakeFeishuApi,
  flush,
  makeChannel,
  makeEntry,
  makeScheduler,
  startAndBind,
  type ChannelHarness,
} from "./helpers/feishu-harness.js";

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function permRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: "req-1",
    sessionId: "s1",
    toolName: "Bash",
    args: { command: "ls -la" },
    risk: "write",
    ...overrides,
  };
}

async function boundHarness(): Promise<{ h: ChannelHarness; openId: string }> {
  const h = makeChannel({ sessions: [makeEntry("s1", "测试会话")] });
  cleanup.push(h.baseDir);
  const openId = await startAndBind(h);
  h.api.texts.length = 0;
  h.api.cards.length = 0;
  return { h, openId };
}

describe("permission 卡片链路", () => {
  it("permission.request → 白名单用户收到交互卡片（工具名/参数摘要/risk 徽章/批准拒绝按钮）", async () => {
    const { h } = await boundHarness();
    h.emit({ type: "permission.request", request: permRequest() });
    await flush();

    expect(h.api.cards).toHaveLength(1);
    const card = h.api.cards[0]!.card;
    expect(cardText(card)).toContain("Bash");
    expect(cardText(card)).toContain("ls -la");
    expect(cardText(card)).toContain("批准");
    expect(cardText(card)).toContain("拒绝");
    expect((card.header as { template: string }).template).toBe("orange"); // write 级
    await h.channel.stop();
  });

  it("danger 级：红色头 + 按钮文案「确认允许危险操作」+ 完整参数展示", async () => {
    const { h } = await boundHarness();
    const longCmd = "rm -rf ".repeat(200); // 超摘要截断长度，danger 也要完整
    h.emit({ type: "permission.request", request: permRequest({ risk: "danger", args: { command: longCmd } }) });
    await flush();

    const card = h.api.cards[0]!.card;
    expect((card.header as { template: string }).template).toBe("red");
    expect(cardText(card)).toContain("确认允许危险操作");
    expect(cardText(card)).toContain(longCmd.slice(0, 100)); // 不被 800 字摘要截断
    await h.channel.stop();
  });

  it("按钮回调 → bridge.replyPermission(by=remote)；permission.resolved 更新原卡片为已批准（来自飞书端）", async () => {
    const { h, openId } = await boundHarness();
    h.emit({ type: "permission.request", request: permRequest() });
    await flush();
    const sentMessageId = h.api.cards[0]!.messageId;

    h.api.emitCardAction({
      operatorOpenId: openId,
      value: { action: "permission", requestId: "req-1", approved: true },
      messageId: sentMessageId,
    });
    await flush();
    expect(h.permissionReplies).toEqual([{ requestId: "req-1", approved: true, by: "remote" }]);

    // 真实链路里 bridge 广播 permission.resolved；这里模拟事件，验证原卡片被 patch
    h.emit({ type: "permission.resolved", requestId: "req-1", approved: true, by: "remote" });
    await flush();
    expect(h.api.updates).toHaveLength(1);
    expect(h.api.updates[0]!.messageId).toBe(sentMessageId);
    expect(cardText(h.api.updates[0]!.card)).toContain("已批准（来自飞书端）");
    await h.channel.stop();
  });

  it("桌面端裁决（by=local）→ 飞书卡片同步更新为已拒绝（来自桌面端）", async () => {
    const { h } = await boundHarness();
    h.emit({ type: "permission.request", request: permRequest({ requestId: "req-9" }) });
    await flush();

    h.emit({ type: "permission.resolved", requestId: "req-9", approved: false, by: "local" });
    await flush();
    expect(h.api.updates).toHaveLength(1);
    expect(cardText(h.api.updates[0]!.card)).toContain("已拒绝（来自桌面端）");
    await h.channel.stop();
  });

  it("非白名单用户的卡片回调一律忽略", async () => {
    const { h } = await boundHarness();
    h.emit({ type: "permission.request", request: permRequest() });
    await flush();

    h.api.emitCardAction({
      operatorOpenId: "ou_stranger",
      value: { action: "permission", requestId: "req-1", approved: true },
      messageId: "m1",
    });
    await flush();
    expect(h.permissionReplies).toHaveLength(0);
    await h.channel.stop();
  });
});

describe("question 映射", () => {
  it("单题单选带选项 → 选项按钮卡片；回调 → replyQuestion + 原卡片更新为已回答", async () => {
    const { h, openId } = await boundHarness();
    const request: QuestionRequest = {
      requestId: "q1",
      sessionId: "s1",
      questions: [{ question: "选哪个方案？", options: [{ label: "方案A" }, { label: "方案B", description: "更稳" }] }],
    };
    h.emit({ type: "question.request", request });
    await flush();
    expect(h.api.cards).toHaveLength(1);
    const text = cardText(h.api.cards[0]!.card);
    expect(text).toContain("选哪个方案？");
    expect(text).toContain("方案A");

    h.api.emitCardAction({
      operatorOpenId: openId,
      value: { action: "question", requestId: "q1", answers: { "0": "方案A" } },
      messageId: "m1",
    });
    await flush();
    expect(h.questionReplies).toEqual([{ requestId: "q1", answers: { "0": "方案A" } }]);
    expect(h.api.updates).toHaveLength(1);
    expect(cardText(h.api.updates[0]!.card)).toContain("已回答");
    await h.channel.stop();
  });

  it("多题 / 多选 → 降级为文本提问并引导桌面端", async () => {
    const { h } = await boundHarness();
    const request: QuestionRequest = {
      requestId: "q2",
      sessionId: "s1",
      questions: [
        { question: "问题一", options: [{ label: "A" }] },
        { question: "问题二", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] },
      ],
    };
    h.emit({ type: "question.request", request });
    await flush();
    expect(h.api.cards).toHaveLength(0);
    expect(h.api.texts).toHaveLength(1);
    expect(h.api.texts[0]!.text).toContain("问题一");
    expect(h.api.texts[0]!.text).toContain("桌面端");
    await h.channel.stop();
  });
});

describe("输出摘要与任务通知", () => {
  it("session.output 缓冲 + running→idle 跳变 → 归属用户收到完成摘要（含输出尾部）", async () => {
    const { h, openId } = await boundHarness();
    // 用户创建会话，成为归属人
    h.api.emitMessage({ openId, text: "/new 做个测试", chatType: "p2p" });
    await flush();
    const sessionId = [...h.registry.entries.keys()].at(-1)!;
    h.api.texts.length = 0;

    // 模拟流式输出 + 完成（agent_start → text_delta → agent_settled）
    h.emit({ type: "session.event", sessionId, event: { type: "agent_start" } });
    h.emit({
      type: "session.event",
      sessionId,
      event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "这是输出的最后一段" } },
    });
    h.emit({ type: "session.event", sessionId, event: { type: "agent_settled" } });
    await flush();

    const summary = h.api.texts.find((t) => t.openId === openId && t.text.includes("已完成"));
    expect(summary).toBeTruthy();
    expect(summary!.text).toContain("这是输出的最后一段");
    await h.channel.stop();
  });

  it("无归属会话（桌面端发起）完成时不推送摘要", async () => {
    const { h } = await boundHarness();
    h.emit({ type: "session.event", sessionId: "s1", event: { type: "agent_start" } });
    h.emit({ type: "session.event", sessionId: "s1", event: { type: "agent_settled" } });
    await flush();
    expect(h.api.texts.filter((t) => t.text.includes("已完成"))).toHaveLength(0);
    await h.channel.stop();
  });

  it("schedule.fired → 白名单广播文本通知；sessions.changed 不主动推", async () => {
    const { h } = await boundHarness();
    h.emit({ type: "schedule.fired", taskId: "t1", name: "晨报", sessionId: "s9" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toContain("晨报");

    h.api.texts.length = 0;
    h.emit({ type: "sessions.changed" });
    await flush();
    expect(h.api.texts).toHaveLength(0);
    await h.channel.stop();
  });
});

// ---------------------------------------------------------------------------
// RemoteServer 集成：飞书通道生命周期与 RemoteStatus 透出（脱敏）
// ---------------------------------------------------------------------------

describe("RemoteServer 集成", () => {
  const tailscaleStub = {
    detect: async () => {},
    status: () => ({ available: false, enabled: false, url: null }),
    enable: async () => null,
    disable: async () => {},
  } as unknown as TailscaleManager;

  function makeServerDeps(baseDir: string, feishu: { enabled: boolean; appId: string; appSecret: string }) {
    const registryH = makeChannel({ baseDir }); // 复用夹具的 registry/scheduler（channel 不启动）
    const settings = {
      get: () => ({ ...DEFAULT_SETTINGS, remote: { ...DEFAULT_SETTINGS.remote, feishu } }),
    };
    const listeners = new Set<(e: HostEvent) => void>();
    const deps: RemoteServerDeps = {
      bridge: {
        async call() {
          return { ok: true };
        },
        replyPermission: () => {},
        replyQuestion: () => {},
        emitLocal: () => {},
        onEvent: (cb) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      },
      scheduler: makeScheduler().scheduler,
      registry: registryH.registry,
      settings,
      pairing: new PairingManager({ baseDir }),
      feishuBaseDir: baseDir,
      tailscale: tailscaleStub,
    };
    return deps;
  }

  it("feishu.enabled + appId/appSecret → 通道独立启动；status 透出 connected / pendingBindCode / configured（不含 secret）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "spcode-feishu-server-"));
    cleanup.push(baseDir);
    const fakeApi = new FakeFeishuApi();
    const deps = makeServerDeps(baseDir, { enabled: true, appId: "cli_x", appSecret: "super-secret-value" });
    deps.feishuApi = fakeApi;
    const server = new RemoteServer(deps);

    await server.applySettings(); // remote.enabled=false，但 feishu.enabled=true → 通道独立启动
    expect(fakeApi.started).toBe(1);
    expect(server.isRunning()).toBe(false); // WS 传输层未启动

    const status = server.status();
    expect(status.feishu.state).toBe("connected");
    expect(status.feishu.configured).toBe(true);
    expect(status.feishu.pendingBindCode).toMatch(/^\d{6}$/);
    expect(status.feishu.allowlistCount).toBe(0);
    // 脱敏：整个 status 里不得出现 appSecret / appId
    const raw = JSON.stringify(status);
    expect(raw).not.toContain("super-secret-value");
    expect(raw).not.toContain("cli_x");

    // 配置未变化时重复 applySettings 不重启通道
    await server.applySettings();
    expect(fakeApi.started).toBe(1);

    await server.stop();
    expect(fakeApi.stopped).toBe(1);
  });

  it("feishu 未启用 → state=disabled，pendingBindCode=null，unbind 空操作", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "spcode-feishu-server-"));
    cleanup.push(baseDir);
    const server = new RemoteServer(makeServerDeps(baseDir, { enabled: false, appId: "", appSecret: "" }));

    await server.applySettings();
    const status = server.status();
    expect(status.feishu.state).toBe("disabled");
    expect(status.feishu.configured).toBe(false);
    expect(status.feishu.pendingBindCode).toBeNull();
    expect(server.unbindFeishuUser("ou_x")).toBe(false);
    await server.stop();
  });

  it("长连接建连失败 → state=error（不抛出，状态透出）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "spcode-feishu-server-"));
    cleanup.push(baseDir);
    const failingApi = new FakeFeishuApi();
    failingApi.start = async () => {
      throw new Error("auth failed");
    };
    const deps = makeServerDeps(baseDir, { enabled: true, appId: "cli_bad", appSecret: "x" });
    deps.feishuApi = failingApi;
    const server = new RemoteServer(deps);

    await server.applySettings();
    expect(server.status().feishu.state).toBe("error");
    expect(server.status().feishu.pendingBindCode).toBeNull();
    await server.stop();
  });
});
