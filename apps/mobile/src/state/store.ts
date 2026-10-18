/**
 * 全局状态（zustand）：UI 与协议层分离——client.ts 只管帧收发，
 * controller.ts 把 RemoteEvent 翻译成这里的状态变更。
 *
 * 输出流模型（M2 断线补拉）：
 * - 每会话的原始 chunk 按 seq 存进 outputRaw（实时事件与 backfill 共用一份）；
 * - 渲染列表 outputs 由 raw 推导：seq 跳号处插「断线期间未同步」缺口标记，
 *   backfill 补齐后标记自动消除；桌面只保留最近 500 个 chunk，
 *   补不齐的缺口标记保留（M1 语义）；
 * - 桌面侧 seq 每会话从 0 单调递增，故 raw 最小 seq > 0 即意味着更早的输出已截断。
 */

import type {
  PermissionRequest,
  QuestionRequest,
  RemoteOutputChunk,
  ScheduleTask,
  SessionMeta,
  TodoItem,
} from "@spcode/shared";
import { create } from "zustand";
import type { ConnectionState } from "../lib/client";
import type { PairingRecord } from "../lib/db";

export type Route = { name: "pair" } | { name: "sessions" } | { name: "session"; id: string } | { name: "schedules" };

export type SessionStatus = "running" | "idle" | "waiting_permission";

export interface OutputChunk {
  /** 列表渲染 key（自增，分配后不变） */
  id: number;
  chunk: string;
  kind: "text" | "thinking";
  /** seq 缺口标记（断线期间 / 桌面缓冲截断导致未同步的输出） */
  gap?: boolean;
}

export interface SessionView extends SessionMeta {
  status: SessionStatus;
}

/** 单会话输出缓存上限（超出丢弃最旧，防长时间挂机撑爆内存） */
const MAX_CHUNKS = 2000;

interface AppState {
  route: Route;
  connState: ConnectionState;
  connDetail?: string;
  pairing: PairingRecord | null;
  sessions: Record<string, SessionView>;
  outputs: Record<string, OutputChunk[]>;
  todos: Record<string, TodoItem[]>;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  schedules: ScheduleTask[];
  /** Web Push：remote.hello 下发的 VAPID 公钥（null = 桌面未推送/不支持） */
  vapidKey: string | null;

  setRoute(route: Route): void;
  setConn(state: ConnectionState, detail?: string): void;
  setPairing(record: PairingRecord | null): void;
  setSessions(metas: SessionMeta[]): void;
  patchSession(id: string, patch: Partial<SessionView>): void;
  removeSession(id: string): void;
  appendOutput(sessionId: string, chunk: string, kind: "text" | "thinking", seq: number): void;
  mergeBackfill(sessionId: string, chunks: RemoteOutputChunk[]): void;
  setTodos(sessionId: string, todos: TodoItem[]): void;
  pushPermission(req: PermissionRequest): void;
  dropPermission(requestId: string): void;
  pushQuestion(req: QuestionRequest): void;
  dropQuestion(requestId: string): void;
  setSchedules(tasks: ScheduleTask[]): void;
  setVapidKey(key: string | null): void;
  reset(): void;
}

const initialData = {
  route: { name: "sessions" } as Route,
  connState: "connecting" as ConnectionState,
  connDetail: undefined as string | undefined,
  pairing: null as PairingRecord | null,
  sessions: {} as Record<string, SessionView>,
  outputs: {} as Record<string, OutputChunk[]>,
  todos: {} as Record<string, TodoItem[]>,
  permissions: [] as PermissionRequest[],
  questions: [] as QuestionRequest[],
  schedules: [] as ScheduleTask[],
  vapidKey: null as string | null,
};

/** session.output 的 per-session 状态（模块级，不进 zustand 避免无谓重渲染） */
interface OutputTrack {
  /** seq → 原始 chunk（实时与 backfill 共用，backfill 据此精确补缺口） */
  raw: Map<number, { kind: "text" | "thinking"; chunk: string }>;
  /** 已收到的最大 seq（session.output.since 的 afterSeq 依据） */
  maxSeq: number;
}

const outputTracks: Record<string, OutputTrack> = {};

/** OutputChunk 渲染 key 计数器 */
let chunkIdCounter = 0;

function trackOf(sessionId: string): OutputTrack {
  let t = outputTracks[sessionId];
  if (!t) {
    t = { raw: new Map(), maxSeq: -1 };
    outputTracks[sessionId] = t;
  }
  return t;
}

/** raw 超限：丢弃最旧 seq（Map 重排为升序后从头删） */
function trimRaw(t: OutputTrack): void {
  if (t.raw.size <= MAX_CHUNKS) return;
  const sorted = [...t.raw.entries()].sort((a, b) => a[0] - b[0]);
  t.raw = new Map(sorted.slice(sorted.length - MAX_CHUNKS));
}

/** 由 raw 推导渲染列表：seq 跳号插缺口标记；相邻同 kind 合并减少重渲染 */
function buildView(t: OutputTrack): OutputChunk[] {
  const seqs = [...t.raw.keys()].sort((a, b) => a - b);
  const view: OutputChunk[] = [];
  let prev = -1; // 上一个已呈现的 seq（桌面 seq 从 0 起，故首 chunk seq>0 = 头部截断缺口）
  for (const seq of seqs) {
    if (seq > prev + 1) view.push({ id: chunkIdCounter++, chunk: "", kind: "text", gap: true });
    const c = t.raw.get(seq)!;
    const last = view[view.length - 1];
    if (last && !last.gap && last.kind === c.kind) {
      view[view.length - 1] = { ...last, chunk: last.chunk + c.chunk };
    } else {
      view.push({ id: chunkIdCounter++, chunk: c.chunk, kind: c.kind });
    }
    prev = seq;
  }
  if (view.length > MAX_CHUNKS) return view.slice(view.length - MAX_CHUNKS);
  return view;
}

/** 某会话已收到的最大 output seq；从未收到返回 undefined（backfill 时用 afterSeq=-1） */
export function getOutputMaxSeq(sessionId: string): number | undefined {
  const t = outputTracks[sessionId];
  return t && t.maxSeq >= 0 ? t.maxSeq : undefined;
}

export const useAppStore = create<AppState>((set) => ({
  ...initialData,

  setRoute: (route) => set({ route }),
  setConn: (connState, detail) => set({ connState, connDetail: detail }),
  setPairing: (pairing) => set({ pairing }),

  setSessions: (metas) =>
    set((s) => {
      const sessions: Record<string, SessionView> = {};
      for (const m of metas) sessions[m.id] = { ...m, status: s.sessions[m.id]?.status ?? "idle" };
      return { sessions };
    }),

  patchSession: (id, patch) =>
    set((s) => (s.sessions[id] ? { sessions: { ...s.sessions, [id]: { ...s.sessions[id]!, ...patch } } } : {})),

  removeSession: (id) =>
    set((s) => {
      if (!s.sessions[id]) return {};
      delete outputTracks[id];
      const sessions = { ...s.sessions };
      const outputs = { ...s.outputs };
      const todos = { ...s.todos };
      delete sessions[id];
      delete outputs[id];
      delete todos[id];
      return { sessions, outputs, todos };
    }),

  appendOutput: (sessionId, chunk, kind, seq) =>
    set((s) => {
      const t = trackOf(sessionId);
      if (t.raw.has(seq)) return {}; // backfill 已含此 seq（实时/backfill 竞争），忽略重复
      t.raw.set(seq, { kind, chunk });
      trimRaw(t);
      const prevMax = t.maxSeq;
      t.maxSeq = Math.max(prevMax, seq);
      // 乱序（正常不会发生，relay 补投/竞争兜底）：整表重建最稳
      if (seq < prevMax) return { outputs: { ...s.outputs, [sessionId]: buildView(t) } };
      // 常见路径：增量追加（保持 M1 的渲染性能）
      const prev = s.outputs[sessionId] ?? [];
      const next = prev.slice();
      if (prevMax >= 0 && seq > prevMax + 1) {
        next.push({ id: chunkIdCounter++, chunk: "", kind: "text", gap: true });
      } else if (prevMax < 0 && seq > 0 && prev.length === 0) {
        next.push({ id: chunkIdCounter++, chunk: "", kind: "text", gap: true }); // 头部截断
      }
      const last = next[next.length - 1];
      if (last && !last.gap && last.kind === kind) {
        next[next.length - 1] = { ...last, chunk: last.chunk + chunk }; // 同 kind 合并
      } else {
        next.push({ id: chunkIdCounter++, chunk, kind });
      }
      if (next.length > MAX_CHUNKS)
        return { outputs: { ...s.outputs, [sessionId]: next.slice(next.length - MAX_CHUNKS) } };
      return { outputs: { ...s.outputs, [sessionId]: next } };
    }),

  mergeBackfill: (sessionId, chunks) =>
    set((s) => {
      if (chunks.length === 0) return {};
      const t = trackOf(sessionId);
      for (const c of chunks) {
        if (!t.raw.has(c.seq)) t.raw.set(c.seq, { kind: c.kind, chunk: c.chunk });
        t.maxSeq = Math.max(t.maxSeq, c.seq);
      }
      // 重排为升序（backfill 可能补的是比现有 seq 小的缺口）再裁剪、重建视图：
      // 补齐的缺口标记消除，仍缺（桌面只留最近 500 个 chunk）的保留
      t.raw = new Map([...t.raw.entries()].sort((a, b) => a[0] - b[0]));
      trimRaw(t);
      return { outputs: { ...s.outputs, [sessionId]: buildView(t) } };
    }),

  setTodos: (sessionId, todos) => set((s) => ({ todos: { ...s.todos, [sessionId]: todos } })),

  pushPermission: (req) =>
    set((s) =>
      s.permissions.some((p) => p.requestId === req.requestId) ? {} : { permissions: [...s.permissions, req] },
    ),

  dropPermission: (requestId) => set((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== requestId) })),

  pushQuestion: (req) =>
    set((s) => (s.questions.some((q) => q.requestId === req.requestId) ? {} : { questions: [...s.questions, req] })),

  dropQuestion: (requestId) => set((s) => ({ questions: s.questions.filter((q) => q.requestId !== requestId) })),

  setSchedules: (schedules) => set({ schedules }),

  setVapidKey: (vapidKey) => set({ vapidKey }),

  reset: () => {
    for (const k of Object.keys(outputTracks)) delete outputTracks[k];
    set({ ...initialData });
  },
}));
