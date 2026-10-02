/**
 * 控制器：UI 动作 → RemoteCommand；RemoteEvent → store。
 * 模块级单例（一个 App 一条连接），UI 组件只调这里的函数。
 */

import type { RemoteCommand, RemoteEvent, ScheduleTaskInput, SessionMode } from "@spcode/shared";
import { RemoteClient } from "../lib/client";
import { clearPairing, loadPairing, type PairingRecord } from "../lib/db";
import { useAppStore } from "./store";

let client: RemoteClient | null = null;

export function getClient(): RemoteClient | null {
  return client;
}

/** App 启动：读 IndexedDB 配对记录；有则建连，无则进配对页 */
export async function boot(): Promise<void> {
  const store = useAppStore.getState();
  let record: PairingRecord | null = null;
  try {
    record = await loadPairing();
  } catch {
    record = null; // IndexedDB 不可用（隐私模式等）时按未配对处理
  }
  if (!record) {
    store.setRoute({ name: "pair" });
    return;
  }
  store.setPairing(record);
  store.setRoute({ name: "sessions" });
  startClient(record);
}

function startClient(record: PairingRecord): void {
  client?.stop();
  const store = useAppStore.getState();
  client = new RemoteClient(record, {
    onEvent: handleEvent,
    onState: (state, detail) => {
      useAppStore.getState().setConn(state, detail);
      if (state === "ready") void refreshAll();
    },
  });
  store.setConn("connecting");
  client.start();
}

export function attachPairedRecord(record: PairingRecord): void {
  useAppStore.getState().setPairing(record);
  useAppStore.getState().setRoute({ name: "sessions" });
  startClient(record);
}

/** 解除配对：清本地记录 + 停连接 + 重置状态（桌面侧设备列表需在桌面设置页移除） */
export async function unpair(): Promise<void> {
  client?.stop();
  client = null;
  try {
    await clearPairing();
  } catch {
    // ignore
  }
  useAppStore.getState().reset();
  useAppStore.getState().setRoute({ name: "pair" });
}

// ---------------------------------------------------------------------------
// 事件 → store
// ---------------------------------------------------------------------------

function handleEvent(event: RemoteEvent): void {
  const s = useAppStore.getState();
  switch (event.type) {
    case "session.snapshot":
      s.setSessions(event.sessions);
      break;
    case "session.status":
      s.patchSession(event.sessionId, { status: event.status, updatedAt: Date.now() });
      break;
    case "session.output":
      s.appendOutput(event.sessionId, event.chunk, event.kind ?? "text", event.seq);
      break;
    case "session.todo":
      s.setTodos(event.sessionId, event.todos);
      break;
    case "session.renamed":
      s.patchSession(event.sessionId, { title: event.title });
      break;
    case "permission.request":
      s.pushPermission(event.request);
      s.patchSession(event.request.sessionId, { status: "waiting_permission" });
      break;
    case "question.request":
      s.pushQuestion(event.request);
      break;
    case "schedule.fired":
      void refreshSchedules();
      break;
    case "sessions.changed":
      void send({ type: "session.list" })
        .then((data) => s.setSessions((data as { sessions: never[] }).sessions))
        .catch(() => {});
      break;
    case "session.usage":
    case "session.planmode":
      break; // M1 不展示
  }
}

// ---------------------------------------------------------------------------
// 命令封装（UI 调用）
// ---------------------------------------------------------------------------

async function send<T = unknown>(cmd: RemoteCommand): Promise<T> {
  if (!client) throw new Error("未连接");
  return client.command<T>(cmd);
}

/** ready 后拉全量：会话列表 + 定时任务（快照事件也会推会话，双保险） */
async function refreshAll(): Promise<void> {
  const s = useAppStore.getState();
  try {
    const data = await send<{ sessions: Parameters<typeof s.setSessions>[0] }>({ type: "session.list" });
    s.setSessions(data.sessions);
  } catch {
    // 快照事件兜底
  }
  await refreshSchedules();
}

export async function refreshSchedules(): Promise<void> {
  try {
    const data = await send<{ tasks: import("@spcode/shared").ScheduleTask[] }>({ type: "schedule.list" });
    useAppStore.getState().setSchedules(data.tasks);
  } catch {
    // 非 ready 等场景忽略
  }
}

export async function createSession(input: { mode: SessionMode; prompt: string; cwd?: string }): Promise<string> {
  const data = await send<{ sessionId: string }>({
    type: "session.create",
    mode: input.mode,
    prompt: input.prompt,
    ...(input.mode === "project" && input.cwd ? { cwd: input.cwd } : {}),
  });
  useAppStore.getState().setRoute({ name: "session", id: data.sessionId });
  return data.sessionId;
}

export async function sendPrompt(sessionId: string, text: string): Promise<void> {
  await send({ type: "session.prompt", sessionId, text });
}

export async function abortSession(sessionId: string): Promise<void> {
  await send({ type: "session.abort", sessionId });
}

/** 权限批复：先到先得——本地先移除卡片，重复响应对端会忽略 */
export async function replyPermission(requestId: string, approved: boolean): Promise<void> {
  useAppStore.getState().dropPermission(requestId);
  await send({ type: "permission.reply", requestId, approved }).catch(() => {});
}

export async function replyQuestion(requestId: string, answers: Record<string, string>): Promise<void> {
  useAppStore.getState().dropQuestion(requestId);
  await send({ type: "question.reply", requestId, answers }).catch(() => {});
}

export async function toggleSchedule(taskId: string, enabled: boolean): Promise<void> {
  await send({ type: "schedule.update", id: taskId, patch: { enabled } satisfies Partial<ScheduleTaskInput> });
  await refreshSchedules();
}

export async function runScheduleNow(taskId: string): Promise<void> {
  await send({ type: "schedule.runNow", id: taskId });
  await refreshSchedules();
}

export async function removeSchedule(taskId: string): Promise<void> {
  await send({ type: "schedule.remove", id: taskId });
  await refreshSchedules();
}
