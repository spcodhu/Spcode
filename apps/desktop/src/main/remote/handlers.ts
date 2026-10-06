/**
 * RemoteCommand 分发：手机端命令 → bridge / scheduler / registry 调用。
 *
 * 所有依赖走结构接口（RemoteBridge / RemoteScheduler / RegistryLike），
 * 不 import agent-bridge.ts（它依赖 electron，单测环境不可用）；
 * withId 本地实现，等价于 AgentBridge.withId。
 */

import { randomUUID } from "node:crypto";
import {
  type AppSettings,
  baseName,
  cleanSessionTitle,
  type HostCommand,
  type HostEvent,
  type RemoteCommand,
  type ScheduleTask,
  type ScheduleTaskInput,
  type SessionMode,
} from "@spcode/shared";
import {
  backfillSessionFile,
  isDefaultTitle,
  type RegistryLike,
  removeSession,
  renameSession,
} from "../session-helpers.js";

export interface RemoteBridge {
  call<T = unknown>(cmd: Extract<HostCommand, { id: string }>): Promise<T>;
  replyPermission(requestId: string, approved: boolean): void;
  replyQuestion(requestId: string, answers: Record<string, string>): void;
  /** 主进程本地事件广播（session.renamed / sessions.changed）；测试桩可省略 */
  emitLocal?(event: HostEvent): void;
}

export interface RemoteScheduler {
  list(): ScheduleTask[];
  create(input: ScheduleTaskInput): ScheduleTask;
  update(id: string, patch: Partial<ScheduleTaskInput>): ScheduleTask | null;
  remove(id: string): void;
  runNow(id: string): Promise<string>;
}

export interface RemoteSettingsReader {
  get(): AppSettings;
}

export interface RemoteHandlerDeps {
  bridge: RemoteBridge;
  scheduler: RemoteScheduler;
  registry: RegistryLike;
  settings: RemoteSettingsReader;
}

/** 与 AgentBridge.withId 等价的本地实现（避免 import electron 依赖链） */
export function withId<T extends Omit<Extract<HostCommand, { id: string }>, "id">>(cmd: T): T & { id: string } {
  return { ...cmd, id: randomUUID() };
}

export async function handleRemoteCommand(cmd: RemoteCommand, deps: RemoteHandlerDeps): Promise<unknown> {
  switch (cmd.type) {
    case "session.list":
      return { sessions: deps.registry.list() };
    case "session.create":
      return createSession(cmd, deps);
    case "session.prompt": {
      // 与渲染进程 IPC 链路同款兜底：标题还是出厂默认时，用首条用户消息推导
      const entry = deps.registry.get(cmd.sessionId);
      if (entry && isDefaultTitle(entry.title, entry.cwd)) {
        const title = cleanSessionTitle(cmd.text);
        if (title) deps.registry.patch(entry.id, { title });
      }
      await deps.bridge.call(withId({ type: "session.prompt", payload: { sessionId: cmd.sessionId, text: cmd.text } }));
      return { ok: true };
    }
    case "session.abort":
      await deps.bridge.call(withId({ type: "session.abort", payload: { sessionId: cmd.sessionId } }));
      return { ok: true };
    case "session.subscribe":
      // M1：所有 RemoteEvent 本就广播给全部已配对设备，订阅无需登记
      return { ok: true };
    case "permission.reply":
      deps.bridge.replyPermission(cmd.requestId, cmd.approved);
      return { ok: true };
    case "question.reply":
      deps.bridge.replyQuestion(cmd.requestId, cmd.answers);
      return { ok: true };
    case "schedule.list":
      return { tasks: deps.scheduler.list() };
    case "schedule.create":
      return { task: deps.scheduler.create(cmd.input) };
    case "schedule.update": {
      const task = deps.scheduler.update(cmd.id, cmd.patch);
      if (!task) throw new Error(`任务不存在：${cmd.id}`);
      return { task };
    }
    case "schedule.remove":
      deps.scheduler.remove(cmd.id);
      return { ok: true };
    case "schedule.runNow":
      return { sessionId: await deps.scheduler.runNow(cmd.id) };
    case "session.rename": {
      // 与桌面端同一套注册表逻辑；session.renamed 事件同步渲染进程与各远程端
      const ok = renameSession({ registry: deps.registry, events: deps.bridge }, cmd.sessionId, cmd.title);
      if (!ok) throw new Error(`会话不存在或标题为空：${cmd.sessionId}`);
      return { ok: true };
    }
    case "session.remove":
      // 与 IPC removeSession 同一套清理：注册表 + 计划文件 + 宿主实例 + sessions.changed 广播
      await removeSession({ registry: deps.registry, bridge: deps.bridge, events: deps.bridge }, cmd.sessionId);
      return { ok: true };
    default:
      throw new Error(`未知远程命令：${(cmd as { type: string }).type}`);
  }
}

/**
 * 远程创建会话 + 注入首条 prompt：与 fireScheduledTask 同款链路
 * （registry.upsert → session.create → backfill → session.prompt），
 * 但保留标题自动化（标题先给出厂默认，首条 prompt 触发兜底推导）。
 */
async function createSession(
  cmd: Extract<RemoteCommand, { type: "session.create" }>,
  deps: RemoteHandlerDeps,
): Promise<{ sessionId: string }> {
  const sessionId = randomUUID();
  const mode: SessionMode = cmd.mode;
  const cwd = cmd.mode === "project" ? (cmd.cwd ?? "") : "";
  const model = cmd.model ?? deps.settings.get().defaultModel;
  const thinkingLevel = deps.settings.get().defaultThinkingLevel;
  const now = Date.now();
  deps.registry.upsert({
    id: sessionId,
    mode,
    cwd,
    title: mode === "chat" ? "新聊天" : baseName(cwd) || "新项目",
    model,
    thinkingLevel,
    sessionFile: null,
    createdAt: now,
    updatedAt: now,
  });
  const createCmd = withId({
    type: "session.create",
    payload: { sessionId, mode, cwd, model: model ?? undefined, thinkingLevel },
  });
  const info = await deps.bridge.call(createCmd);
  backfillSessionFile(createCmd, info, deps.registry);
  // 首条 prompt 标题兜底（与 IPC 链路 session.prompt 行为对齐）
  const entry = deps.registry.get(sessionId);
  if (entry && isDefaultTitle(entry.title, entry.cwd)) {
    const title = cleanSessionTitle(cmd.prompt);
    if (title) deps.registry.patch(sessionId, { title });
  }
  await deps.bridge.call(withId({ type: "session.prompt", payload: { sessionId, text: cmd.prompt } }));
  return { sessionId };
}
