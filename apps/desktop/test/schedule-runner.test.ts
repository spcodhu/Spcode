import type { HostCommand, ScheduleTask, SessionInfo, SessionRegistryEntry } from "@spcode/shared";
import { describe, expect, it } from "vitest";
import { runScheduledRetry, runScheduledTask, type ScheduleRunnerDeps } from "../src/main/schedule-runner.js";

function task(patch: Partial<ScheduleTask> = {}): ScheduleTask {
  return {
    id: "task-1",
    name: "日报",
    prompt: "生成日报",
    target: { kind: "chat" },
    frequency: "daily",
    hour: 9,
    minute: 0,
    enabled: true,
    createdAt: 0,
    ...patch,
  };
}

function info(sessionId: string, sessionFile = `/tmp/${sessionId}.jsonl`): SessionInfo {
  return {
    sessionId,
    sessionFile,
    planMode: false,
    running: false,
    permissionMode: "never",
    sandbox: { state: "disabled" },
    model: null,
    thinkingLevel: "medium",
    supportedThinkingLevels: [],
  };
}

function setup(entries: SessionRegistryEntry[] = [], running = false) {
  const registryEntries = [...entries];
  const calls: Extract<HostCommand, { id: string }>[] = [];
  const registry: ScheduleRunnerDeps["registry"] = {
    list: () => registryEntries,
    get: (id) => registryEntries.find((entry) => entry.id === id),
    upsert: (entry) => {
      const index = registryEntries.findIndex((item) => item.id === entry.id);
      if (index >= 0) registryEntries[index] = entry;
      else registryEntries.unshift(entry);
    },
    patch: (id, patch) => {
      const index = registryEntries.findIndex((entry) => entry.id === id);
      if (index >= 0) registryEntries[index] = { ...registryEntries[index]!, ...patch };
    },
    remove: (id) => {
      const index = registryEntries.findIndex((entry) => entry.id === id);
      if (index >= 0) registryEntries.splice(index, 1);
    },
  };
  const bridge: ScheduleRunnerDeps["bridge"] = {
    call: async <T>(cmd: Extract<HostCommand, { id: string }>): Promise<T> => {
      calls.push(cmd);
      return { ...info(cmd.payload.sessionId), running } as T;
    },
  };
  const deps: ScheduleRunnerDeps = {
    registry,
    bridge,
    settings: {
      get: () => ({ defaultModel: null, defaultThinkingLevel: "medium", permissionMode: "auto" }),
    },
    newSessionId: () => "new-session",
  };
  return { deps, calls, registryEntries };
}

function entry(patch: Partial<SessionRegistryEntry> = {}): SessionRegistryEntry {
  return {
    id: "existing",
    mode: "project",
    cwd: "/code/demo",
    title: "已有会话",
    titleKind: "custom",
    model: null,
    thinkingLevel: "medium",
    sessionFile: "/tmp/existing.jsonl",
    planMode: false,
    permissionMode: "ask",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

describe("定时任务执行器", () => {
  it("已有会话只唤醒并注入，不重复 create；应用任务选择的权限模式", async () => {
    const { deps, calls } = setup([entry({ planMode: true })]);
    const images = [{ name: "a.png", mimeType: "image/png", data: "aGVsbG8=" }];
    const result = await runScheduledTask(
      task({ target: { kind: "session", sessionId: "existing" }, images, permissionMode: "ask" }),
      deps,
    );
    expect(result).toBe("existing");
    expect(calls.map((call) => call.type)).toEqual(["session.activate", "session.setPermissionMode", "session.prompt"]);
    expect(calls[0]).toMatchObject({
      payload: {
        sessionId: "existing",
        sessionFile: "/tmp/existing.jsonl",
        cwd: "/code/demo",
        planMode: true,
        permissionMode: "ask",
      },
    });
    expect(calls[1]).toMatchObject({ payload: { sessionId: "existing", mode: "ask" } });
    expect(calls[2]).toMatchObject({ payload: { sessionId: "existing", text: "生成日报", images } });
  });

  it("已有会话缺失或无恢复文件时明确失败，不发送 prompt", async () => {
    for (const targetEntry of [undefined, entry({ sessionFile: null })]) {
      const { deps, calls } = setup(targetEntry ? [targetEntry] : []);
      await expect(
        runScheduledTask(task({ target: { kind: "session", sessionId: "existing" } }), deps),
      ).rejects.toThrow();
      expect(calls).toHaveLength(0);
    }
  });

  it("新会话仍走 create → prompt，并保留任务模型与图片", async () => {
    const { deps, calls, registryEntries } = setup();
    const model = { provider: "demo", modelId: "vision" };
    const images = [{ name: "a.png", mimeType: "image/png", data: "aGVsbG8=" }];
    const result = await runScheduledTask(task({ model, images }), deps);
    expect(result).toBe("new-session");
    expect(calls.map((call) => call.type)).toEqual(["session.create", "session.prompt"]);
    expect(calls[0]).toMatchObject({
      payload: { sessionId: "new-session", model, permissionMode: "never", noTitleAutomation: true },
    });
    expect(calls[1]).toMatchObject({ payload: { sessionId: "new-session", images } });
    expect(registryEntries[0]).toMatchObject({ id: "new-session", title: "日报", model, permissionMode: "never" });
  });

  it("错误重试在会话忙时顺延，空闲时原样重发文本和图片", async () => {
    const retry = {
      id: "retry-1",
      sessionId: "existing",
      text: "继续生成",
      images: [{ name: "a.png", mimeType: "image/png", data: "aGVsbG8=" }],
      runAt: 100,
      createdAt: 1,
    };
    const busy = setup([entry()], true);
    await expect(runScheduledRetry(retry, busy.deps)).resolves.toBe(false);
    expect(busy.calls.map((call) => call.type)).toEqual(["session.activate"]);

    const idle = setup([entry()], false);
    await expect(runScheduledRetry(retry, idle.deps)).resolves.toBe(true);
    expect(idle.calls.map((call) => call.type)).toEqual(["session.activate", "session.prompt"]);
    expect(idle.calls[1]).toMatchObject({ payload: { text: retry.text, images: retry.images } });
  });
});
