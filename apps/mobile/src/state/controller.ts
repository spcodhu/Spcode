/**
 * 控制器：UI 动作 → RemoteCommand；RemoteEvent → store。
 * 模块级单例（一个 App 一条连接），UI 组件只调这里的函数。
 */

import type {
  QuestionAnswers,
  RemoteEvent as RemoteEventExt,
  RemoteHistoryPage,
  ScheduleTask,
  ScheduleTaskInput,
  SessionMode,
} from "@spcode/shared";
import { RemoteClient } from "../lib/client";
import { clearPairing, loadPairing, type PairingRecord } from "../lib/db";
import { applyDesktopLocale, initializeMobileLocale, MobileError } from "../lib/i18n";
import {
  isPushEnabledLocally,
  isPushSupported,
  setPushEnabledLocally,
  subscribePush,
  unsubscribePush,
} from "../lib/push";
import { getOutputMaxSeq, useAppStore } from "./store";

let client: RemoteClient | null = null;
/** 只采用最后一次发出的 session.list 响应，避免创建会话的刷新被更早的启动刷新覆盖 */
let sessionListRequest = 0;
/** 配对/客户端代次：旧客户端的迟到事件与响应不得覆盖新配对状态。 */
let clientGeneration = 0;
interface OutputRequest {
  generation: number;
  promise: Promise<void>;
}
const outputRequests = new Map<string, OutputRequest>();
const olderOutputRequests = new Map<string, OutputRequest>();

export function getClient(): RemoteClient | null {
  return client;
}

/** App 启动：读 IndexedDB 配对记录；有则建连，无则进配对页 */
export async function boot(): Promise<void> {
  initializeMobileLocale();
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
  // 常规启动仍进列表；若调用方在 cold boot 前已恢复某个详情路由，则保留 sessionId 供 ready 补拉。
  if (useAppStore.getState().route.name !== "session") useAppStore.getState().setRoute({ name: "sessions" });
  startClient(record);
}

function startClient(record: PairingRecord): void {
  const generation = ++clientGeneration;
  sessionListRequest++;
  outputRequests.clear();
  olderOutputRequests.clear();
  client?.stop();
  const store = useAppStore.getState();
  for (const sessionId of Object.keys(store.olderHistoryLoading)) {
    store.setOlderHistoryLoading(sessionId, false);
  }
  client = new RemoteClient(record, {
    onEvent: (event) => {
      if (generation === clientGeneration) handleEvent(event);
    },
    onState: (state, detail) => {
      if (generation !== clientGeneration) return;
      const current = useAppStore.getState();
      if (state === "connecting" || state === "reconnecting") current.setLocaleReady(false);
      current.setConn(state, detail);
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
  clientGeneration++;
  sessionListRequest++;
  outputRequests.clear();
  olderOutputRequests.clear();
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
      s.applySessionSnapshot(event.sessions, event.pendingPermissions ?? [], event.pendingQuestions ?? []);
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
    case "question.resolved":
      // 双端撤卡：另一端已回答/超时（评审 R3-C11）
      s.dropQuestion(event.requestId);
      break;
    case "schedule.fired":
      void refreshSchedules();
      break;
    case "sessions.changed":
      void refreshSessionList();
      break;
    case "locale.changed":
      applyDesktopLocale(event.locale);
      s.setLocaleReady(true);
      break;
    case "remote.hello":
      // A missing locale is an older desktop: explicitly use the shared profile default.
      applyDesktopLocale(event.locale);
      s.setLocaleReady(true);
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
  if (!client) throw new MobileError("error.notConnected");
  return client.command<T>(cmd);
}

async function refreshSessionList(): Promise<void> {
  const request = ++sessionListRequest;
  const generation = clientGeneration;
  try {
    const data = await send<{ sessions: Parameters<ReturnType<typeof useAppStore.getState>["setSessions"]>[0] }>({
      type: "session.list",
    });
    if (request === sessionListRequest && generation === clientGeneration) {
      useAppStore.getState().setSessions(data.sessions);
    }
  } catch {
    // 快照事件兜底
  }
}

/** ready 后拉全量：会话列表 + 定时任务（快照事件也会推会话，双保险） */
async function refreshAll(): Promise<void> {
  await Promise.all([refreshSessionList(), refreshSchedules()]);
}

/**
 * 拉取单个会话输出。相同客户端代次内按 sessionId 去重；loaded/error 在普通路由进入时
 * 不重复请求，只有重连补拉或用户显式重试才强制发起。无缓存时 afterSeq 固定为 -1。
 */
export function ensureSessionOutput(sessionId: string, force = false): Promise<void> {
  const s = useAppStore.getState();
  if (s.connState !== "ready" || !client) return Promise.resolve();
  const existing = outputRequests.get(sessionId);
  if (existing?.generation === clientGeneration) return existing.promise;
  if (!force) {
    const status = s.outputSync[sessionId]?.status;
    if (status === "loaded" || status === "error") return Promise.resolve();
  }

  const generation = clientGeneration;
  const knownSession = !!s.sessions[sessionId];
  s.setOutputSync(sessionId, { status: "loading" });
  const promise = (async () => {
    try {
      let afterSeq = getOutputMaxSeq(sessionId) ?? -1;
      if (s.historyCursors[sessionId] === undefined) {
        const page = await send<RemoteHistoryPage>({ type: "session.history", sessionId });
        if (generation !== clientGeneration) return;
        const current = useAppStore.getState();
        if (knownSession && !current.sessions[sessionId]) return;
        current.replaceHistory(sessionId, page);
        afterSeq = page.outputSeq;
      }
      await send({ type: "session.output.since", sessionId, afterSeq });
      if (generation !== clientGeneration) return;
      const current = useAppStore.getState();
      // 请求期间已被权威列表删除：不要把旧响应重新写回该会话。
      if (knownSession && !current.sessions[sessionId]) return;
      current.setOutputSync(sessionId, { status: "loaded" });
    } catch (error) {
      if (generation !== clientGeneration) return;
      const current = useAppStore.getState();
      if (knownSession && !current.sessions[sessionId]) return;
      current.setOutputSync(sessionId, { status: "error", error });
    }
  })();
  const entry = { generation, promise };
  outputRequests.set(sessionId, entry);
  void promise.finally(() => {
    if (outputRequests.get(sessionId) === entry) outputRequests.delete(sessionId);
  });
  return promise;
}

export function retrySessionOutput(sessionId: string): Promise<void> {
  return ensureSessionOutput(sessionId, true);
}

/** 向前加载一页历史；同一会话同代次去重，旧客户端的迟到响应不得覆盖新游标。 */
export function loadOlderSessionOutput(sessionId: string): Promise<void> {
  const s = useAppStore.getState();
  const before = s.historyCursors[sessionId];
  if (before === undefined || before === null || s.connState !== "ready" || !client) return Promise.resolve();
  const existing = olderOutputRequests.get(sessionId);
  if (existing?.generation === clientGeneration) return existing.promise;

  const generation = clientGeneration;
  s.setOlderHistoryLoading(sessionId, true);
  const promise = (async () => {
    try {
      const page = await send<RemoteHistoryPage>({ type: "session.history", sessionId, before });
      if (generation !== clientGeneration) return;
      const current = useAppStore.getState();
      if (current.historyCursors[sessionId] !== before) return;
      current.prependHistory(sessionId, page.chunks, page.olderBefore);
    } finally {
      if (generation === clientGeneration) useAppStore.getState().setOlderHistoryLoading(sessionId, false);
    }
  })();
  const entry = { generation, promise };
  olderOutputRequests.set(sessionId, entry);
  const cleanup = () => {
    if (olderOutputRequests.get(sessionId) === entry) olderOutputRequests.delete(sessionId);
  };
  void promise.then(cleanup, cleanup);
  return promise;
}

/** 重连后补拉有缓存的会话和当前详情；空缓存的冷启动详情也使用 afterSeq=-1。 */
async function backfillOutputs(): Promise<void> {
  const s = useAppStore.getState();
  const targets = new Set<string>();
  for (const id of Object.keys(s.outputs)) {
    if (getOutputMaxSeq(id) !== undefined) targets.add(id);
  }
  if (s.route.name === "session") targets.add(s.route.id);
  await Promise.all([...targets].map((sessionId) => ensureSessionOutput(sessionId, true)));
}

export async function refreshSchedules(): Promise<void> {
  const generation = clientGeneration;
  try {
    const data = await send<{ tasks: ScheduleTask[] }>({ type: "schedule.list" });
    if (generation === clientGeneration) useAppStore.getState().setSchedules(data.tasks);
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

/** 删除会话（store 统一清理缓存；若正在详情页则退回列表） */
export async function removeSession(sessionId: string): Promise<void> {
  await send({ type: "session.remove", sessionId });
  useAppStore.getState().removeSession(sessionId);
}

export async function sendPrompt(sessionId: string, text: string): Promise<void> {
  await send({ type: "session.prompt", sessionId, text });
}

export async function abortSession(sessionId: string): Promise<void> {
  await send({ type: "session.abort", sessionId });
}

/** 权限/提问回复：只有桌面确认后才撤卡；失败原样抛出，由卡片保留内容并允许手动重试。 */
export async function replyPermission(requestId: string, approved: boolean): Promise<void> {
  await send({ type: "permission.reply", requestId, approved });
  useAppStore.getState().dropPermission(requestId);
}

export async function replyQuestion(requestId: string, answers: QuestionAnswers): Promise<void> {
  await send({ type: "question.reply", requestId, answers });
  useAppStore.getState().dropQuestion(requestId);
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
// Web Push（契约在 packages/shared/src/remote.ts）
// ---------------------------------------------------------------------------

/** 开启通知：订阅 PushManager 并上报桌面；失败抛错由 UI 展示（开关维持关闭） */
export async function enablePushNotifications(): Promise<void> {
  const vapidKey = useAppStore.getState().vapidKey;
  if (!vapidKey) throw new MobileError("error.pushKey");
  const sub = await subscribePush(vapidKey);
  await send({ type: "push.subscribe", subscription: toPushSubscription(sub) });
  setPushEnabledLocally(true);
}

/** PushSubscription.toJSON() → 协议形状（可选字段收窄；缺 endpoint/keys 视为订阅损坏） */
function toPushSubscription(sub: PushSubscription): { endpoint: string; keys: { p256dh: string; auth: string } } {
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) throw new MobileError("error.pushSubscription");
  return { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } };
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
    await send({ type: "push.subscribe", subscription: toPushSubscription(sub) });
  } catch {
    // 订阅失效/授权被收回等：静默，下次 remote.hello 再试
  }
}
