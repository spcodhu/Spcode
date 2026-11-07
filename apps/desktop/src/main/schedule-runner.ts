/** 定时任务执行器：新建会话或唤醒已有会话，然后注入指令与图片。 */

import { randomUUID } from "node:crypto";
import type {
  AppSettings,
  HostCommand,
  HostCommandInput,
  ScheduleTask,
  SessionInfo,
  SessionMode,
} from "@spcode/shared";
import { DEFAULT_SCHEDULE_PERMISSION_MODE } from "@spcode/shared";
import { i18n } from "@spcode/shared/i18n";
import { backfillSessionFile, type RegistryLike } from "./session-helpers.js";

export interface ScheduleRunnerBridge {
  call<T = unknown>(cmd: Extract<HostCommand, { id: string }>): Promise<T>;
}

export interface ScheduleRunnerDeps {
  registry: RegistryLike;
  bridge: ScheduleRunnerBridge;
  settings: {
    get(): Pick<AppSettings, "defaultModel" | "defaultThinkingLevel" | "permissionMode">;
  };
  /** 测试注入；生产使用随机 UUID。 */
  newSessionId?: () => string;
}

function withId(cmd: HostCommandInput): Extract<HostCommand, { id: string }> {
  return { ...cmd, id: cmd.id ?? randomUUID() } as Extract<HostCommand, { id: string }>;
}

async function promptSession(task: ScheduleTask, sessionId: string, deps: ScheduleRunnerDeps): Promise<void> {
  await deps.bridge.call(
    withId({
      type: "session.prompt",
      payload: { sessionId, text: task.prompt, ...(task.images?.length ? { images: task.images } : {}) },
    }),
  );
}

/** 已有会话只 activate，不 create（create 同 id 会销毁并替换原 controller）。 */
async function runInExistingSession(task: ScheduleTask, sessionId: string, deps: ScheduleRunnerDeps): Promise<string> {
  const entry = deps.registry.get(sessionId);
  if (!entry?.sessionFile) throw new Error(i18n.t("integration:session.missing", { id: sessionId }));
  const cmd = withId({
    type: "session.activate",
    payload: {
      sessionId,
      sessionFile: entry.sessionFile,
      cwd: entry.cwd,
      planMode: entry.planMode ?? false,
      permissionMode: entry.permissionMode ?? deps.settings.get().permissionMode,
    },
  });
  const info = await deps.bridge.call<SessionInfo>(cmd);
  backfillSessionFile(cmd, info, deps.registry);
  const permissionMode = task.permissionMode ?? DEFAULT_SCHEDULE_PERMISSION_MODE;
  if (info.permissionMode !== permissionMode) {
    await deps.bridge.call(
      withId({ type: "session.setPermissionMode", payload: { sessionId, mode: permissionMode } }),
    );
  }
  await promptSession(task, sessionId, deps);
  return sessionId;
}

export async function runScheduledTask(task: ScheduleTask, deps: ScheduleRunnerDeps): Promise<string> {
  if (task.target.kind === "session") return runInExistingSession(task, task.target.sessionId, deps);

  const sessionId = deps.newSessionId?.() ?? randomUUID();
  const mode: SessionMode = task.target.kind === "project" ? "project" : "chat";
  const cwd = task.target.kind === "project" ? task.target.cwd : "";
  const current = deps.settings.get();
  const permissionMode = task.permissionMode ?? DEFAULT_SCHEDULE_PERMISSION_MODE;
  const now = Date.now();
  deps.registry.upsert({
    id: sessionId,
    mode,
    cwd,
    title: task.name,
    titleKind: "custom",
    model: task.model ?? current.defaultModel,
    thinkingLevel: current.defaultThinkingLevel,
    permissionMode,
    sessionFile: null,
    createdAt: now,
    updatedAt: now,
  });
  // 与用户手动创建使用同一宿主链路，但关闭标题自动化（标题固定为任务名）。
  const cmd = withId({
    type: "session.create",
    payload: {
      sessionId,
      mode,
      cwd,
      model: task.model ?? current.defaultModel ?? undefined,
      thinkingLevel: current.defaultThinkingLevel,
      permissionMode,
      noTitleAutomation: true,
    },
  });
  const info = await deps.bridge.call<SessionInfo>(cmd);
  backfillSessionFile(cmd, info, deps.registry);
  await promptSession(task, sessionId, deps);
  return sessionId;
}
