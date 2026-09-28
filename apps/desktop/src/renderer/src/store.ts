/**
 * 渲染进程全局状态（Zustand）。
 *
 * 数据流：preload.onEvent 推送 HostEvent → applyHostEvent 归并进 store。
 * pi 的事件流在这里被规整成 UI 直接消费的 ChatMessage/ToolCallState。
 *
 * 更新纪律：sessions map 里的 SessionState 与 messages 数组必须换引用
 * （浅拷贝后修改），否则 selector 订阅不触发重渲染。消息内容本身可变，
 * 列表组件不做 memo，直接读最新值。
 */
import { create } from "zustand";
import type {
  AppSettings,
  HostEvent,
  ModelInfo,
  ModelRef,
  PermissionRequest,
  QuestionRequest,
  SessionMeta,
  SessionMode,
  TodoItem,
  UsageAggregate,
  UsageRecord,
} from "@spcode/shared";

// ---------------------------------------------------------------------------
// UI 消息模型
// ---------------------------------------------------------------------------

export interface ToolCallState {
  id: string;
  name: string;
  args: unknown;
  status: "running" | "done" | "error";
  output: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking: string;
  toolCalls: ToolCallState[];
  streaming: boolean;
}

export interface SessionState {
  meta: SessionMeta;
  messages: ChatMessage[];
  running: boolean;
  usage: UsageAggregate;
  supportedThinkingLevels: string[];
  todos: TodoItem[];
}

/** 主进程注册表里的持久化会话条目（镜像 SessionRegistryEntry） */
export interface RegistrySession {
  id: string;
  mode: SessionMode;
  cwd: string;
  title: string;
  model: ModelRef | null;
  thinkingLevel: string;
  sessionFile: string | null;
  createdAt: number;
  updatedAt: number;
}

interface StoreState {
  ready: boolean;
  hostReady: boolean;
  settings: AppSettings | null;
  models: ModelInfo[];
  sessions: Record<string, SessionState>;
  sessionOrder: string[];
  activeSessionId: string | null;
  registrySessions: RegistrySession[];
  pendingQuestions: QuestionRequest[];
  pendingPermissions: PermissionRequest[];
  lastError: string | null;

  init(): Promise<void>;
  createSession(mode: SessionMode, cwd?: string): Promise<string>;
  openSession(entry: RegistrySession): Promise<void>;
  deleteSession(id: string): Promise<void>;
  setActive(id: string): void;
  sendPrompt(text: string): Promise<void>;
  abort(): Promise<void>;
  setModel(ref: ModelRef): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  replyPermission(requestId: string, approved: boolean): void;
  replyQuestion(requestId: string, answers: Record<string, string>): void;
  applyHostEvent(event: HostEvent): void;
  refreshModels(): Promise<void>;
  saveSettings(patch: Partial<AppSettings>): Promise<void>;
}

// ---------------------------------------------------------------------------
// pi 事件规整
// ---------------------------------------------------------------------------

interface PiContentBlock {
  type: string;
  text?: string;
  thinking?: string;
}

function extractText(content: unknown): { text: string; thinking: string } {
  if (!Array.isArray(content)) return { text: "", thinking: "" };
  let text = "";
  let thinking = "";
  for (const b of content as PiContentBlock[]) {
    if (b.type === "text" && b.text) text += b.text;
    if (b.type === "thinking" && b.thinking) thinking += b.thinking;
  }
  return { text, thinking };
}

function extractResultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return (content as PiContentBlock[])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n");
  }
  try {
    return JSON.stringify(result).slice(0, 2000);
  } catch {
    return String(result);
  }
}

const EMPTY_USAGE: UsageAggregate = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costInput: 0,
  costOutput: 0,
  costCacheRead: 0,
  costCacheWrite: 0,
  costTotal: 0,
  count: 0,
};

function foldUsage(agg: UsageAggregate, u: UsageRecord): UsageAggregate {
  return {
    input: agg.input + u.input,
    output: agg.output + u.output,
    cacheRead: agg.cacheRead + u.cacheRead,
    cacheWrite: agg.cacheWrite + u.cacheWrite,
    costInput: agg.costInput + u.costInput,
    costOutput: agg.costOutput + u.costOutput,
    costCacheRead: agg.costCacheRead + u.costCacheRead,
    costCacheWrite: agg.costCacheWrite + u.costCacheWrite,
    costTotal: agg.costTotal + u.costTotal,
    count: agg.count + 1,
  };
}

let msgSeq = 0;
const nextMsgId = () => `m${++msgSeq}`;

/** 找到或创建当前正在流式输出的 assistant 消息 */
function ensureStreamingMessage(session: SessionState): ChatMessage {
  const last = session.messages[session.messages.length - 1];
  if (last && last.role === "assistant" && last.streaming) return last;
  const msg: ChatMessage = {
    id: nextMsgId(),
    role: "assistant",
    text: "",
    thinking: "",
    toolCalls: [],
    streaming: true,
  };
  session.messages.push(msg);
  return msg;
}

function applySessionEvent(session: SessionState, event: Record<string, unknown>): void {
  const type = event.type as string;
  switch (type) {
    case "message_update": {
      const ame = (event as { assistantMessageEvent?: { type: string; delta?: string } })
        .assistantMessageEvent;
      if (!ame) break;
      if (ame.type === "text_delta" && ame.delta) {
        ensureStreamingMessage(session).text += ame.delta;
      } else if (ame.type === "thinking_delta" && ame.delta) {
        ensureStreamingMessage(session).thinking += ame.delta;
      }
      break;
    }
    case "message_end": {
      const msg = event.message as { role?: string; content?: unknown };
      if (msg.role === "assistant") {
        const cur = ensureStreamingMessage(session);
        const { text, thinking } = extractText(msg.content);
        if (text) cur.text = text;
        if (thinking) cur.thinking = thinking;
        cur.streaming = false;
      }
      break;
    }
    case "tool_execution_start": {
      const cur = ensureStreamingMessage(session);
      cur.toolCalls.push({
        id: event.toolCallId as string,
        name: event.toolName as string,
        args: event.args,
        status: "running",
        output: "",
      });
      break;
    }
    case "tool_execution_update": {
      const tc = findToolCall(session, event.toolCallId as string);
      if (tc) tc.output = extractResultText((event as { partialResult?: unknown }).partialResult);
      break;
    }
    case "tool_execution_end": {
      const tc = findToolCall(session, event.toolCallId as string);
      if (tc) {
        tc.status = (event.isError as boolean) ? "error" : "done";
        tc.output = extractResultText((event as { result?: unknown }).result);
      }
      break;
    }
    case "agent_start":
      session.running = true;
      break;
    case "agent_settled":
      session.running = false;
      break;
  }
}

function findToolCall(session: SessionState, id: string): ToolCallState | undefined {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (!m || m.role !== "assistant") continue;
    const tc = m.toolCalls.find((t) => t.id === id);
    if (tc) return tc;
    if (!m.streaming) break;
  }
  return undefined;
}

/** pi 持久化消息 → UI 消息（恢复会话时回放）。导出供单测使用 */
export function historyToMessages(messages: unknown[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  /** toolCallId → 结果，用于回填工具卡片输出 */
  const toolResults = new Map<string, { text: string; isError: boolean }>();
  for (const raw of messages) {
    const m = raw as {
      role?: string;
      content?: unknown;
      toolCallId?: string;
      isError?: boolean;
    };
    if (m.role === "toolResult" && m.toolCallId) {
      toolResults.set(m.toolCallId, { text: extractResultText(m), isError: !!m.isError });
    }
  }
  for (const raw of messages) {
    const m = raw as { role?: string; content?: unknown };
    if (m.role === "user") {
      const { text } = extractText(m.content);
      if (text) {
        out.push({ id: nextMsgId(), role: "user", text, thinking: "", toolCalls: [], streaming: false });
      }
    } else if (m.role === "assistant") {
      const { text, thinking } = extractText(m.content);
      const toolCalls: ToolCallState[] = [];
      if (Array.isArray(m.content)) {
        for (const b of m.content as { type: string; id?: string; name?: string; arguments?: unknown }[]) {
          if (b.type === "toolCall" && b.id && b.name) {
            const res = toolResults.get(b.id);
            toolCalls.push({
              id: b.id,
              name: b.name,
              args: b.arguments,
              status: res?.isError ? "error" : "done",
              output: res?.text ?? "",
            });
          }
        }
      }
      if (text || thinking || toolCalls.length > 0) {
        out.push({ id: nextMsgId(), role: "assistant", text, thinking, toolCalls, streaming: false });
      }
    }
  }
  return out;
}

/** 浅拷贝 SessionState + messages 数组后再修改，保证引用变化触发渲染 */
function touchSession(
  s: StoreState,
  sessionId: string,
  mutate: (draft: SessionState) => void,
): StoreState {
  const old = s.sessions[sessionId];
  if (!old) return s;
  const draft: SessionState = { ...old, messages: [...old.messages], usage: { ...old.usage } };
  mutate(draft);
  return { ...s, sessions: { ...s.sessions, [sessionId]: draft } };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useStore = create<StoreState>((set, get) => ({
  ready: false,
  hostReady: false,
  settings: null,
  models: [],
  sessions: {},
  sessionOrder: [],
  activeSessionId: null,
  registrySessions: [],
  pendingQuestions: [],
  pendingPermissions: [],
  lastError: null,

  async init() {
    const settings = await window.spcode.getSettings();
    set({ settings });
    window.spcode.onEvent((event) => get().applyHostEvent(event));
    await get().refreshModels();
    const registry = await window.spcode.listSessions().catch(() => []);
    set({ registrySessions: registry ?? [], ready: true });
  },

  async refreshModels() {
    try {
      const models = await window.spcode.command<ModelInfo[]>({ type: "models.list" });
      set({ models: models ?? [] });
    } catch {
      set({ models: [] });
    }
  },

  async createSession(mode, cwd) {
    const settings = get().settings;
    const id = crypto.randomUUID();
    const info = await window.spcode.command<{
      model: ModelRef | null;
      thinkingLevel: string;
      supportedThinkingLevels: string[];
    }>({
      type: "session.create",
      payload: {
        sessionId: id,
        mode,
        cwd: cwd ?? "",
        model: settings?.defaultModel ?? undefined,
        thinkingLevel: settings?.defaultThinkingLevel,
      },
    });
    const now = Date.now();
    const meta: SessionMeta = {
      id,
      mode,
      cwd: cwd ?? "",
      title: mode === "chat" ? "新聊天" : (cwd?.split("/").pop() ?? "新项目"),
      model: info.model,
      thinkingLevel: info.thinkingLevel,
      createdAt: now,
      updatedAt: now,
    };
    const session: SessionState = {
      meta,
      messages: [],
      running: false,
      usage: { ...EMPTY_USAGE },
      supportedThinkingLevels: info.supportedThinkingLevels ?? [],
      todos: [],
    };
    set((s) => ({
      sessions: { ...s.sessions, [id]: session },
      sessionOrder: [id, ...s.sessionOrder],
      activeSessionId: id,
      registrySessions: [
        {
          id,
          mode,
          cwd: cwd ?? "",
          title: meta.title,
          model: info.model,
          thinkingLevel: info.thinkingLevel,
          sessionFile: null,
          createdAt: now,
          updatedAt: now,
        },
        ...s.registrySessions,
      ],
    }));
    return id;
  },

  async openSession(entry) {
    // 已激活的会话直接切换
    if (get().sessions[entry.id]) {
      set({ activeSessionId: entry.id });
      return;
    }
    if (!entry.sessionFile) {
      // 死条目（历史遗留无会话文件）：静默移除并开新会话，不打扰用户
      await window.spcode.removeSession(entry.id).catch(() => {});
      set((s) => ({
        registrySessions: s.registrySessions.filter((x) => x.id !== entry.id),
      }));
      await get().createSession(entry.mode, entry.cwd?.trim() ? entry.cwd : undefined);
      return;
    }
    const info = await window.spcode.command<{
      model: ModelRef | null;
      thinkingLevel: string;
      supportedThinkingLevels: string[];
    }>({
      type: "session.open",
      payload: { sessionId: entry.id, sessionFile: entry.sessionFile, cwd: entry.cwd },
    });
    const session: SessionState = {
      meta: {
        id: entry.id,
        mode: entry.mode,
        cwd: entry.cwd,
        title: entry.title,
        model: info.model,
        thinkingLevel: info.thinkingLevel,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      },
      messages: [],
      running: false,
      usage: { ...EMPTY_USAGE },
      supportedThinkingLevels: info.supportedThinkingLevels ?? [],
      todos: [],
    };
    // 历史消息由随后的 session.history 事件填充
    set((s) => ({
      sessions: { ...s.sessions, [entry.id]: session },
      sessionOrder: [entry.id, ...s.sessionOrder.filter((x) => x !== entry.id)],
      activeSessionId: entry.id,
    }));
  },

  async deleteSession(id) {
    await window.spcode.removeSession(id);
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[id];
      return {
        sessions,
        sessionOrder: s.sessionOrder.filter((x) => x !== id),
        registrySessions: s.registrySessions.filter((x) => x.id !== id),
        activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
      };
    });
  },

  setActive(id) {
    set({ activeSessionId: id });
  },

  async sendPrompt(text) {
    const { activeSessionId } = get();
    if (!activeSessionId || !text.trim()) return;
    set((s) =>
      touchSession(s, activeSessionId, (draft) => {
        draft.messages.push({
          id: nextMsgId(),
          role: "user",
          text,
          thinking: "",
          toolCalls: [],
          streaming: false,
        });
        draft.running = true;
        if (!draft.messages.some((m) => m.role === "user" && m.text !== text)) {
          draft.meta = { ...draft.meta, title: text.trim().slice(0, 30) };
        }
      }),
    );
    try {
      await window.spcode.command({
        type: "session.prompt",
        payload: { sessionId: activeSessionId, text },
      });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  async abort() {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    await window.spcode.command({ type: "session.abort", payload: { sessionId: activeSessionId } });
  },

  async setModel(ref) {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    const info = await window.spcode.command<{
      model: ModelRef | null;
      thinkingLevel: string;
      supportedThinkingLevels: string[];
    }>({ type: "session.setModel", payload: { sessionId: activeSessionId, model: ref } });
    set((s) =>
      touchSession(s, activeSessionId, (draft) => {
        if (info) {
          draft.meta = { ...draft.meta, model: info.model, thinkingLevel: info.thinkingLevel };
          draft.supportedThinkingLevels = info.supportedThinkingLevels ?? [];
        }
      }),
    );
    void get().saveSettings({ defaultModel: ref });
  },

  async setThinkingLevel(level) {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    const info = await window.spcode.command<{ thinkingLevel: string }>({
      type: "session.setThinkingLevel",
      payload: { sessionId: activeSessionId, level },
    });
    set((s) =>
      touchSession(s, activeSessionId, (draft) => {
        if (info) draft.meta = { ...draft.meta, thinkingLevel: info.thinkingLevel };
      }),
    );
  },

  replyPermission(requestId, approved) {
    window.spcode.replyPermission(requestId, approved);
    set((s) => ({
      pendingPermissions: s.pendingPermissions.filter((p) => p.requestId !== requestId),
    }));
  },

  replyQuestion(requestId, answers) {
    window.spcode.replyQuestion(requestId, answers);
    set((s) => ({
      pendingQuestions: s.pendingQuestions.filter((q) => q.requestId !== requestId),
    }));
  },

  async saveSettings(patch) {
    const next = await window.spcode.setSettings(patch);
    set({ settings: next });
  },

  applyHostEvent(event) {
    set((s) => {
      switch (event.type) {
        case "ready":
          return { ...s, hostReady: true };
        case "session.event":
          return touchSession(s, event.sessionId, (draft) =>
            applySessionEvent(draft, event.event as Record<string, unknown>),
          );
        case "session.usage":
          return touchSession(s, event.sessionId, (draft) => {
            draft.usage = foldUsage(draft.usage, event.usage);
          });
        case "session.history":
          return touchSession(s, event.sessionId, (draft) => {
            if (draft.messages.length === 0) {
              draft.messages = historyToMessages(event.messages);
            }
          });
        case "session.todo":
          return touchSession(s, event.sessionId, (draft) => {
            draft.todos = event.todos;
          });
        case "question.request": {
          if (s.pendingQuestions.some((q) => q.requestId === event.request.requestId)) return s;
          return { ...s, pendingQuestions: [...s.pendingQuestions, event.request] };
        }
        case "permission.request": {
          if (s.pendingPermissions.some((p) => p.requestId === event.request.requestId)) return s;
          return { ...s, pendingPermissions: [...s.pendingPermissions, event.request] };
        }
        case "host.error":
          return { ...s, lastError: event.message, hostReady: false };
        default:
          return s;
      }
    });
  },
}));
