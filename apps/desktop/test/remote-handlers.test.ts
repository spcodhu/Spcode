/**
 * RemoteCommand 分发单测：用 mock bridge/scheduler/registry 验证调用契约，
 * 重点是 session.create 链路顺序（upsert → create → backfill → 标题兜底 → prompt）。
 */
import { DEFAULT_SETTINGS, type HostCommand, type ScheduleTask, type ScheduleTaskInput } from "@spcode/shared";
import { describe, expect, it } from "vitest";
import { handleRemoteCommand, type RemoteHandlerDeps } from "../src/main/remote/handlers.js";
import type { RegistryLike } from "../src/main/session-helpers.js";
import type { SessionRegistryEntry } from "../src/main/session-registry.js";

function makeRegistry(): RegistryLike & { entries: Map<string, SessionRegistryEntry> } {
  const entries = new Map<string, SessionRegistryEntry>();
  return {
    entries,
    list: () => [...entries.values()],
    get: (id) => entries.get(id),
    upsert: (entry) => void entries.set(entry.id, entry),
    patch: (id, patch) => {
      const cur = entries.get(id);
      if (cur) entries.set(id, { ...cur, ...patch, id, updatedAt: Date.now() });
    },
  };
}

function makeDeps() {
  const bridgeCalls: HostCommand[] = [];
  const permissionReplies: { requestId: string; approved: boolean }[] = [];
  const questionReplies: { requestId: string; answers: Record<string, string> }[] = [];
  const schedulerCalls: string[] = [];
  const registry = makeRegistry();
  const task: ScheduleTask = {
    id: "t1",
    name: "晨报",
    prompt: "早报",
    target: { kind: "chat" },
    frequency: "daily",
    hour: 9,
    minute: 0,
    enabled: true,
    createdAt: 0,
  };
  const deps: RemoteHandlerDeps = {
    bridge: {
      async call(cmd: HostCommand & { id: string }) {
        bridgeCalls.push(cmd);
        if (cmd.type === "session.create") {
          return {
            sessionId: cmd.payload.sessionId,
            sessionFile: `/tmp/${cmd.payload.sessionId}.jsonl`,
            model: { provider: "anthropic", modelId: "claude" },
            thinkingLevel: "high",
          };
        }
        return { ok: true };
      },
      replyPermission: (requestId, approved) => permissionReplies.push({ requestId, approved }),
      replyQuestion: (requestId, answers) => questionReplies.push({ requestId, answers }),
    },
    scheduler: {
      list: () => {
        schedulerCalls.push("list");
        return [task];
      },
      create: (input: ScheduleTaskInput) => {
        schedulerCalls.push("create");
        return { ...input, id: "t2", createdAt: 1 };
      },
      update: (id: string, patch: Partial<ScheduleTaskInput>) => {
        schedulerCalls.push(`update:${id}`);
        return id === "t1" ? { ...task, ...patch } : null;
      },
      remove: (id: string) => schedulerCalls.push(`remove:${id}`),
      runNow: async (id: string) => {
        schedulerCalls.push(`runNow:${id}`);
        return "sess-run";
      },
    },
    registry,
    settings: {
      get: () => ({
        ...DEFAULT_SETTINGS,
        defaultModel: { provider: "openai", modelId: "gpt-x" },
        defaultThinkingLevel: "medium",
      }),
    },
  };
  return { deps, bridgeCalls, permissionReplies, questionReplies, schedulerCalls, registry, task };
}

describe("session.create 链路", () => {
  it("顺序：registry.upsert → session.create → backfill → 标题兜底 → session.prompt", async () => {
    const { deps, bridgeCalls, registry } = makeDeps();
    const result = (await handleRemoteCommand(
      { type: "session.create", mode: "chat", prompt: "帮我写一个脚本" },
      deps,
    )) as { sessionId: string };
    expect(result.sessionId).toBeTruthy();

    // bridge 调用顺序：先 create 后 prompt，sessionId 一致
    expect(bridgeCalls.map((c) => c.type)).toEqual(["session.create", "session.prompt"]);
    const [createCmd, promptCmd] = bridgeCalls as [
      Extract<HostCommand, { type: "session.create" }>,
      Extract<HostCommand, { type: "session.prompt" }>,
    ];
    expect(createCmd.payload.sessionId).toBe(result.sessionId);
    expect(promptCmd.payload).toEqual({ sessionId: result.sessionId, text: "帮我写一个脚本" });
    // model 取设置默认值（命令未指定时）
    expect(createCmd.payload.model).toEqual({ provider: "openai", modelId: "gpt-x" });

    // backfill：sessionFile / model / thinkingLevel 用宿主返回覆盖
    const entry = registry.entries.get(result.sessionId)!;
    expect(entry.sessionFile).toBe(`/tmp/${result.sessionId}.jsonl`);
    expect(entry.model).toEqual({ provider: "anthropic", modelId: "claude" });
    expect(entry.thinkingLevel).toBe("high");
    // 标题兜底：出厂默认 → 首条 prompt 推导
    expect(entry.title).toBe("帮我写一个脚本");
  });

  it("project 模式：cwd 传递，标题兜底为目录名", async () => {
    const { deps, bridgeCalls, registry } = makeDeps();
    const result = (await handleRemoteCommand(
      { type: "session.create", mode: "project", cwd: "/code/my-app", prompt: "看下这个仓库" },
      deps,
    )) as { sessionId: string };
    const createCmd = bridgeCalls[0] as Extract<HostCommand, { type: "session.create" }>;
    expect(createCmd.payload).toMatchObject({ mode: "project", cwd: "/code/my-app" });
    expect(registry.entries.get(result.sessionId)?.title).toBe("看下这个仓库");
  });
});

describe("session.prompt / abort / subscribe", () => {
  it("prompt：直调 bridge.call；出厂默认标题时用首条消息兜底", async () => {
    const { deps, bridgeCalls, registry } = makeDeps();
    registry.entries.set("s1", {
      id: "s1",
      mode: "chat",
      cwd: "",
      title: "新聊天",
      model: null,
      thinkingLevel: "medium",
      sessionFile: null,
      createdAt: 0,
      updatedAt: 0,
    });
    const r = await handleRemoteCommand({ type: "session.prompt", sessionId: "s1", text: "查一下天气" }, deps);
    expect(r).toEqual({ ok: true });
    expect(bridgeCalls[0]).toMatchObject({ type: "session.prompt", payload: { sessionId: "s1", text: "查一下天气" } });
    expect(registry.entries.get("s1")?.title).toBe("查一下天气");
  });

  it("abort：直调 bridge.call", async () => {
    const { deps, bridgeCalls } = makeDeps();
    await handleRemoteCommand({ type: "session.abort", sessionId: "s1" }, deps);
    expect(bridgeCalls[0]).toMatchObject({ type: "session.abort", payload: { sessionId: "s1" } });
  });

  it("subscribe：M1 全量广播，返回 ok", async () => {
    const { deps } = makeDeps();
    expect(await handleRemoteCommand({ type: "session.subscribe", sessionId: "s1" }, deps)).toEqual({ ok: true });
  });

  it("session.list：返回注册表内容", async () => {
    const d = makeDeps();
    const r = (await handleRemoteCommand({ type: "session.list" }, d.deps)) as { sessions: unknown[] };
    expect(r.sessions).toEqual([]);
  });
});

describe("permission / question 回复", () => {
  it("permission.reply → bridge.replyPermission", async () => {
    const { deps, permissionReplies } = makeDeps();
    await handleRemoteCommand({ type: "permission.reply", requestId: "r1", approved: true }, deps);
    expect(permissionReplies).toEqual([{ requestId: "r1", approved: true }]);
  });

  it("question.reply → bridge.replyQuestion", async () => {
    const { deps, questionReplies } = makeDeps();
    await handleRemoteCommand({ type: "question.reply", requestId: "q1", answers: { a: "b" } }, deps);
    expect(questionReplies).toEqual([{ requestId: "q1", answers: { a: "b" } }]);
  });
});

describe("schedule.* 分发", () => {
  it("list / create / update / remove / runNow", async () => {
    const { deps, schedulerCalls, task } = makeDeps();
    const input: ScheduleTaskInput = {
      name: "新任务",
      prompt: "p",
      target: { kind: "chat" },
      frequency: "daily",
      hour: 8,
      minute: 30,
      enabled: true,
    };
    const created = (await handleRemoteCommand({ type: "schedule.create", input }, deps)) as { task: ScheduleTask };
    expect(created.task.id).toBe("t2");
    const listed = (await handleRemoteCommand({ type: "schedule.list" }, deps)) as { tasks: ScheduleTask[] };
    expect(listed.tasks).toEqual([task]);
    const updated = (await handleRemoteCommand({ type: "schedule.update", id: "t1", patch: { enabled: false } }, deps)) as {
      task: ScheduleTask;
    };
    expect(updated.task.enabled).toBe(false);
    await handleRemoteCommand({ type: "schedule.remove", id: "t1" }, deps);
    const run = (await handleRemoteCommand({ type: "schedule.runNow", id: "t1" }, deps)) as { sessionId: string };
    expect(run.sessionId).toBe("sess-run");
    expect(schedulerCalls).toEqual(["create", "list", "update:t1", "remove:t1", "runNow:t1"]);
  });

  it("schedule.update 不存在 → 抛错（由 RemoteServer 转为 ok:false 响应）", async () => {
    const { deps } = makeDeps();
    await expect(handleRemoteCommand({ type: "schedule.update", id: "nope", patch: {} }, deps)).rejects.toThrow(
      "任务不存在",
    );
  });
});
