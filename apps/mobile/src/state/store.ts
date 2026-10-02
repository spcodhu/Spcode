/**
 * 全局状态（zustand）：UI 与协议层分离——client.ts 只管帧收发，
 * controller.ts 把 RemoteEvent 翻译成这里的状态变更。
 */

import type { PermissionRequest, QuestionRequest, ScheduleTask, SessionMeta, TodoItem } from "@spcode/shared";
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
  /** seq 缺口标记（断线期间的输出无法补拉） */
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

  setRoute(route: Route): void;
  setConn(state: ConnectionState, detail?: string): void;
  setPairing(record: PairingRecord | null): void;
  setSessions(metas: SessionMeta[]): void;
  patchSession(id: string, patch: Partial<SessionView>): void;
  appendOutput(sessionId: string, chunk: string, kind: "text" | "thinking", seq: number): void;
  setTodos(sessionId: string, todos: TodoItem[]): void;
  pushPermission(req: PermissionRequest): void;
  dropPermission(requestId: string): void;
  pushQuestion(req: QuestionRequest): void;
  dropQuestion(requestId: string): void;
  setSchedules(tasks: ScheduleTask[]): void;
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
};

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

  appendOutput: (sessionId, chunk, kind, seq) =>
    set((s) => {
      const prev = s.outputs[sessionId] ?? [];
      const expected = outputSeqs[sessionId];
      const gap = expected !== undefined && seq !== expected + 1;
      outputSeqs[sessionId] = seq;
      let next = prev.slice();
      if (gap) next.push({ id: chunkIdCounter++, chunk: "", kind: "text", gap: true });
      const last = next[next.length - 1];
      if (last && !last.gap && last.kind === kind) {
        // 同 kind 合并，减少重渲染
        next[next.length - 1] = { ...last, chunk: last.chunk + chunk };
      } else {
        next.push({ id: chunkIdCounter++, chunk, kind });
      }
      if (next.length > MAX_CHUNKS) next = next.slice(next.length - MAX_CHUNKS);
      return { outputs: { ...s.outputs, [sessionId]: next } };
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

  reset: () => {
    for (const k of Object.keys(outputSeqs)) delete outputSeqs[k];
    set({ ...initialData });
  },
}));

/** session.output 的 per-session seq 追踪（事件类型里 seq 每会话独立递增） */
const outputSeqs: Record<string, number> = {};

/** OutputChunk 渲染 key 计数器 */
let chunkIdCounter = 0;
