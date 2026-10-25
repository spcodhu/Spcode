/** 移动控制器：冷启动补拉、快照对账、回复失败与客户端代次。 */
import type { QuestionRequest, RemoteCommand, SessionMeta } from "@spcode/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteClientCallbacks } from "../src/lib/client";
import type { PairingRecord } from "../src/lib/db";
import {
  attachPairedRecord,
  boot,
  ensureSessionOutput,
  replyPermission,
  replyQuestion,
  retrySessionOutput,
  unpair,
} from "../src/state/controller";
import { useAppStore } from "../src/state/store";

const mocks = vi.hoisted(() => ({
  callbacks: [] as RemoteClientCallbacks[],
  command: vi.fn<(cmd: RemoteCommand) => Promise<unknown>>(),
  loadPairing: vi.fn<() => Promise<PairingRecord | null>>(),
}));

vi.mock("../src/lib/db", () => ({
  loadPairing: mocks.loadPairing,
  savePairing: vi.fn(async () => {}),
  clearPairing: vi.fn(async () => {}),
}));
vi.mock("../src/lib/client", () => ({
  RemoteClient: class {
    command = mocks.command;
    constructor(_record: PairingRecord, cb: RemoteClientCallbacks) {
      mocks.callbacks.push(cb);
    }
    start() {}
    stop() {}
  },
}));

const record: PairingRecord = {
  version: 1,
  desktopPk: "desktop",
  deviceId: "device",
  hosts: ["http://localhost"],
  deviceName: "test",
  keyPair: { publicKey: "public", secretKey: "secret" },
  pairedAt: 1,
};
const session: SessionMeta = {
  id: "s1",
  mode: "chat",
  cwd: "",
  title: "现有会话",
  model: null,
  thinkingLevel: "medium",
  sessionFile: null,
  createdAt: 1,
  updatedAt: 2,
};
const question: QuestionRequest = { requestId: "q-new", sessionId: "s1", questions: [{ question: "问题" }] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function callback(index = -1): RemoteClientCallbacks {
  return mocks.callbacks.at(index)!;
}

function outputCalls(): RemoteCommand[] {
  return mocks.command.mock.calls.map(([cmd]) => cmd).filter((cmd) => cmd.type === "session.output.since");
}

beforeEach(() => {
  useAppStore.getState().reset();
  mocks.callbacks.length = 0;
  mocks.command.mockReset();
  mocks.loadPairing.mockReset().mockResolvedValue(record);
  mocks.command.mockImplementation(async (cmd) => {
    if (cmd.type === "session.list") return { sessions: [session] };
    if (cmd.type === "schedule.list") return { tasks: [] };
    if (cmd.type === "session.output.since") return { count: 0 };
    return { ok: true };
  });
});

afterEach(async () => {
  await unpair();
});

describe("冷启动与路由输出补拉", () => {
  it("已有 sessionId 在 ready 时以 afterSeq=-1 补拉，加载成功才标记 loaded", async () => {
    const pending = deferred<{ count: number }>();
    mocks.command.mockImplementation(async (cmd) => {
      if (cmd.type === "session.output.since") return pending.promise;
      if (cmd.type === "session.list") return { sessions: [session] };
      if (cmd.type === "schedule.list") return { tasks: [] };
      return { ok: true };
    });
    useAppStore.getState().setSessions([session]);
    useAppStore.getState().setRoute({ name: "session", id: session.id });
    await boot();
    callback().onState("ready");

    expect(outputCalls()).toEqual([{ type: "session.output.since", sessionId: "s1", afterSeq: -1 }]);
    expect(useAppStore.getState().outputSync.s1?.status).toBe("loading");
    pending.resolve({ count: 0 });
    await vi.waitFor(() => expect(useAppStore.getState().outputSync.s1?.status).toBe("loaded"));

    await ensureSessionOutput("s1");
    useAppStore.getState().setRoute({ name: "sessions" });
    useAppStore.getState().setRoute({ name: "session", id: "s1" });
    await ensureSessionOutput("s1");
    expect(outputCalls()).toHaveLength(1);
  });

  it("失败保留错误且不随路由重进自动重发，显式重试才发起第二请求", async () => {
    mocks.command.mockImplementation(async (cmd) => {
      if (cmd.type === "session.output.since") {
        if (outputCalls().length === 1) throw new Error("backfill failed");
        return { count: 0 };
      }
      if (cmd.type === "session.list") return { sessions: [session] };
      if (cmd.type === "schedule.list") return { tasks: [] };
      return { ok: true };
    });
    useAppStore.getState().setSessions([session]);
    attachPairedRecord(record);
    useAppStore.getState().setRoute({ name: "session", id: "s1" });
    callback().onState("ready");
    await vi.waitFor(() => expect(useAppStore.getState().outputSync.s1?.status).toBe("error"));
    expect(useAppStore.getState().outputSync.s1).toMatchObject({ error: new Error("backfill failed") });

    await ensureSessionOutput("s1");
    expect(outputCalls()).toHaveLength(1);
    await retrySessionOutput("s1");
    expect(outputCalls()).toHaveLength(2);
    expect(useAppStore.getState().outputSync.s1?.status).toBe("loaded");
  });

  it("同一 sessionId 的在途请求跨路由切换复用，不重复发送", async () => {
    const pending = deferred<{ count: number }>();
    mocks.command.mockImplementation(async (cmd) => {
      if (cmd.type === "session.output.since") return pending.promise;
      if (cmd.type === "session.list") return { sessions: [session] };
      if (cmd.type === "schedule.list") return { tasks: [] };
      return { ok: true };
    });
    useAppStore.getState().setSessions([session]);
    attachPairedRecord(record);
    useAppStore.getState().setRoute({ name: "session", id: "s1" });
    callback().onState("ready");
    const first = ensureSessionOutput("s1");
    useAppStore.getState().setRoute({ name: "sessions" });
    useAppStore.getState().setRoute({ name: "session", id: "s1" });
    const second = ensureSessionOutput("s1");
    expect(second).toBe(first);
    expect(outputCalls()).toHaveLength(1);
    pending.resolve({ count: 0 });
    await Promise.all([first, second]);
  });
});

describe("权威快照与回复可靠性", () => {
  it("快照替换状态/权限/提问，并退出被远端删除的详情路由", () => {
    const s = useAppStore.getState();
    s.setSessions([session, { ...session, id: "gone", title: "被删除" }]);
    s.patchSession("s1", { status: "running" });
    s.patchSession("gone", { status: "waiting_permission" });
    s.pushPermission({ requestId: "p-old", sessionId: "gone", toolName: "bash", args: {}, risk: "write" });
    s.pushQuestion({ requestId: "q-old", sessionId: "gone", questions: [] });
    attachPairedRecord(record);
    s.setRoute({ name: "session", id: "gone" });

    callback().onEvent({
      type: "session.snapshot",
      sessions: [{ ...session, status: "idle" }],
      pendingPermissions: [{ requestId: "p-new", sessionId: "s1", toolName: "read", args: {}, risk: "readonly" }],
      pendingQuestions: [question],
    });
    const next = useAppStore.getState();
    expect(next.sessions.s1?.status).toBe("idle");
    expect(next.sessions.gone).toBeUndefined();
    expect(next.permissions.map((request) => request.requestId)).toEqual(["p-new"]);
    expect(next.questions.map((request) => request.requestId)).toEqual(["q-new"]);
    expect(next.route).toEqual({ name: "sessions" });
  });

  it("权限/提问等待响应，失败保留卡片和答案，手动重试成功后才撤卡", async () => {
    const permissionPending = deferred<{ ok: boolean }>();
    const questionPending = deferred<{ ok: boolean }>();
    mocks.command.mockImplementation((cmd) => {
      if (cmd.type === "permission.reply") return permissionPending.promise;
      if (cmd.type === "question.reply") return questionPending.promise;
      return Promise.resolve({ ok: true });
    });
    const s = useAppStore.getState();
    s.setSessions([session]);
    s.pushPermission({ requestId: "p1", sessionId: "s1", toolName: "bash", args: {}, risk: "write" });
    s.pushQuestion(question);
    s.setQuestionDraft(question.requestId, { answers: {}, freeText: { "0": "保留答案" } });
    attachPairedRecord(record);

    const permissionReply = replyPermission("p1", true);
    const questionReply = replyQuestion(question.requestId, { "0": { kind: "text", text: "保留答案" } });
    expect(useAppStore.getState().permissions).toHaveLength(1);
    expect(useAppStore.getState().questions).toHaveLength(1);
    permissionPending.reject(new Error("permission timeout"));
    questionPending.reject(new Error("question timeout"));
    await expect(permissionReply).rejects.toThrow("permission timeout");
    await expect(questionReply).rejects.toThrow("question timeout");
    expect(useAppStore.getState().permissions).toHaveLength(1);
    expect(useAppStore.getState().questions).toHaveLength(1);
    expect(useAppStore.getState().questionDrafts[question.requestId]?.freeText["0"]).toBe("保留答案");
    expect(mocks.command.mock.calls.filter(([cmd]) => cmd.type === "permission.reply")).toHaveLength(1);
    expect(mocks.command.mock.calls.filter(([cmd]) => cmd.type === "question.reply")).toHaveLength(1);

    mocks.command.mockImplementation(async () => ({ ok: true }));
    await replyPermission("p1", true);
    await replyQuestion(question.requestId, { "0": { kind: "text", text: "保留答案" } });
    expect(useAppStore.getState().permissions).toHaveLength(0);
    expect(useAppStore.getState().questions).toHaveLength(0);
    expect(useAppStore.getState().questionDrafts[question.requestId]).toBeUndefined();
  });

  it("旧客户端 stop 后的迟到 ready/快照不会覆盖新客户端状态", () => {
    attachPairedRecord(record);
    const old = callback();
    old.onState("ready");
    attachPairedRecord({ ...record, deviceId: "new-device" });
    const current = callback();
    expect(useAppStore.getState().connState).toBe("connecting");

    old.onState("ready");
    old.onEvent({
      type: "session.snapshot",
      sessions: [{ ...session, id: "stale", status: "running" }],
      pendingPermissions: [],
      pendingQuestions: [],
    });
    expect(useAppStore.getState().connState).toBe("connecting");
    expect(useAppStore.getState().sessions.stale).toBeUndefined();
    current.onEvent({
      type: "session.snapshot",
      sessions: [{ ...session, status: "idle" }],
      pendingPermissions: [],
      pendingQuestions: [],
    });
    expect(useAppStore.getState().sessions.s1?.status).toBe("idle");
  });
});
