/**
 * 控制器：UI 动作 → RemoteCommand；RemoteEvent → store。
 * 模块级单例（一个 App 一条连接），UI 组件只调这里的函数。
 */

import type { ScheduleTask, ScheduleTaskInput, SessionMode } from "@spcode/shared";
import { RemoteClient } from "../lib/client";
import { clearPairing, loadPairing, type PairingRecord } from "../lib/db";
import type { RemoteEventExt } from "../lib/protocol";
import {
  isPushEnabledLocally,
  isPushSupported,
  setPushEnabledLocally,
  subscribePush,
  unsubscribePush,
} from "../lib/push";
import { getOutputMaxSeq, useAppStore } from "./store";

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
      if (state === "ready") {
        void refreshAll();
        void backfillOutputs(); // 断线补拉：auth 成功后按已收到的最大 seq 补缺口
      }
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

function handleEvent(event: RemoteEventExt): void {
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
    case "session.output.backfill":
      // 断线补拉结果：按 seq 合并进输出流（补齐即消除缺口标记）
      s.mergeBackfill(event.sessionId, event.chunks);
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
    case "permission.resolved":
      // 双端撤卡：另一端已批复同一请求，本端卡片直接关闭
      s.dropPermission(event.requestId);
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
    case "remote.hello":
      // Web Push 契约：auth 成功后桌面下发 VAPID 公钥；已开启通知则（重）上报订阅
      s.setVapidKey(event.vapidPublicKey);
      void resubscribePushIfEnabled(event.vapidPublicKey);
      break;
    case "session.usage":
    case "session.planmode":
      break; // 暂不展示
  }
}

// ---------------------------------------------------------------------------
// 命令封装（UI 调用）
// ---------------------------------------------------------------------------

async function send<T = unknown>(cmd: Parameters<RemoteClient["command"]>[0]): Promise<T> {
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

/**
 * 断线补拉：对「已有输出记录的会话 + 当前打开的会话」发 session.output.since，
 * 桌面回 session.output.backfill 事件（只含 seq > afterSeq 的 chunk），由 mergeBackfill 合并。
 */
async function backfillOutputs(): Promise<void> {
  const s = useAppStore.getState();
  const targets = new Set<string>();
  for (const id of Object.keys(s.outputs)) {
    if (getOutputMaxSeq(id) !== undefined) targets.add(id);
  }
  if (s.route.name === "session") targets.add(s.route.id); // 打开的会话：即使本地无记录也补最近输出
  for (const sessionId of targets) {
    const afterSeq = getOutputMaxSeq(sessionId) ?? -1;
    try {
      await send({ type: "session.output.since", sessionId, afterSeq });
    } catch {
      // 连接抖动等：缺口标记保留，下次重连再补
    }
  }
}

export async function refreshSchedules(): Promise<void> {
  try {
    const data = await send<{ tasks: ScheduleTask[] }>({ type: "schedule.list" });
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

/** 重命名会话（桌面完成后广播 session.renamed / sessions.changed，此处先本地生效） */
export async function renameSession(sessionId: string, title: string): Promise<void> {
  await send({ type: "session.rename", sessionId, title });
  useAppStore.getState().patchSession(sessionId, { title });
}

/** 删除会话（桌面完成后广播 sessions.changed；本地立即移除，若正在详情页则退回列表） */
export async function removeSession(sessionId: string): Promise<void> {
  await send({ type: "session.remove", sessionId });
  const s = useAppStore.getState();
  s.removeSession(sessionId);
  if (s.route.name === "session" && s.route.id === sessionId) s.setRoute({ name: "sessions" });
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

export async function createSchedule(input: ScheduleTaskInput): Promise<void> {
  await send({ type: "schedule.create", input });
  await refreshSchedules();
}

export async function updateSchedule(taskId: string, patch: Partial<ScheduleTaskInput>): Promise<void> {
  await send({ type: "schedule.update", id: taskId, patch });
  await refreshSchedules();
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

// ---------------------------------------------------------------------------
// Web Push（契约见 lib/protocol.ts 的 TODO(契约收敛)）
// ---------------------------------------------------------------------------

/** 开启通知：订阅 PushManager 并上报桌面；失败抛错由 UI 展示（开关维持关闭） */
export async function enablePushNotifications(): Promise<void> {
  const vapidKey = useAppStore.getState().vapidKey;
  if (!vapidKey) throw new Error("桌面端尚未下发推送公钥（remote.hello），请确认桌面端已升级到支持推送的版本并重连");
  const sub = await subscribePush(vapidKey);
  await send({ type: "push.subscribe", subscription: sub.toJSON() });
  setPushEnabledLocally(true);
}

/** 关闭通知：本地退订（桌面侧订阅随连接失效，无需显式下线命令） */
export async function disablePushNotifications(): Promise<void> {
  await unsubscribePush();
}

/** remote.hello 到达时：本地已开启过通知则重新上报订阅（桌面重启后推送路由需重建）；静默降级 */
async function resubscribePushIfEnabled(vapidKey: string): Promise<void> {
  if (!isPushSupported() || !isPushEnabledLocally()) return;
  try {
    const sub = await subscribePush(vapidKey);
    await send({ type: "push.subscribe", subscription: sub.toJSON() });
  } catch {
    // 订阅失效/授权被收回等：静默，下次 remote.hello 再试
  }
}
