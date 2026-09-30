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

import type {
  AppSettings,
  HostEvent,
  ImageAttachment,
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
import { baseName, cleanSessionTitle } from "@spcode/shared";
import { create } from "zustand";

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

/**
 * 消息内容按到达顺序组织成段（segment），渲染时严格单向追加、绝不重排：
 * - thinking：一段思考（done=false 表示正在流入）
 * - text：一段正文（阶段性总结或最终答复）
 * - tools：一段连续的工具调用（中途插入其它段则另起一段）
 */
export type Segment =
  | { kind: "thinking"; id: string; text: string; done: boolean }
  | { kind: "text"; id: string; text: string }
  | { kind: "tools"; id: string; calls: ToolCallState[] };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  segments: Segment[];
  /** 用户消息携带的图片附件（base64 内联，用于气泡缩略图） */
  images?: ImageAttachment[];
  streaming: boolean;
}

/** 消息的全部正文文本（user 标题、测试断言用） */
export function messageText(m: ChatMessage): string {
  return m.segments
    .filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text")
    .map((s) => s.text)
    .join("\n\n");
}

/**
 * 把一次运行（连续多条 assistant 消息）的段拍平成一条时间线：
 * 跨消息相邻的同类段合并（连续多轮思考并为一块、连续工具调用并为一批），
 * 不同类段之间保持到达顺序。渲染层只认这条时间线，保证输出单向无插叙。
 * 导出供单测使用。
 */
export function flattenSegments(messages: ChatMessage[]): Segment[] {
  const out: Segment[] = [];
  for (const m of messages) {
    for (const s of m.segments) {
      const last = out[out.length - 1];
      if (s.kind === "thinking" && last?.kind === "thinking") {
        last.text = last.text && s.text ? `${last.text}\n\n${s.text}` : last.text || s.text;
        last.done = last.done && s.done;
      } else if (s.kind === "tools" && last?.kind === "tools") {
        last.calls = [...last.calls, ...s.calls];
      } else if (s.kind === "text" && !s.text.trim()) {
      } else {
        out.push(s.kind === "tools" ? { ...s, calls: [...s.calls] } : { ...s });
      }
    }
  }
  return out;
}

/**
 * 渲染分组：一次任务运行 = 用户消息之后连续的 assistant 消息
 * （agentic 循环里每个模型回合一条）。运行时各回合的段会被
 * flattenSegments 拍平成一条单向时间线。
 * 导出供单测使用。
 */
export type RenderItem =
  | { kind: "user"; key: string; message: ChatMessage }
  | { kind: "run"; key: string; messages: ChatMessage[] };

export function groupMessagesForRender(messages: ChatMessage[]): RenderItem[] {
  const items: RenderItem[] = [];
  let run: ChatMessage[] = [];
  const flush = () => {
    const first = run[0];
    if (first) items.push({ kind: "run", key: first.id, messages: [...run] });
    run = [];
  };
  for (const m of messages) {
    if (m.role === "assistant") {
      run.push(m);
    } else {
      flush();
      items.push({ kind: "user", key: m.id, message: m });
    }
  }
  flush();
  return items;
}

export interface SessionState {
  meta: SessionMeta;
  messages: ChatMessage[];
  running: boolean;
  usage: UsageAggregate;
  /** 最近一次请求的用量快照：上下文占用 = input + cacheRead（Finch 同款口径） */
  lastUsage: UsageRecord | null;
  supportedThinkingLevels: string[];
  todos: TodoItem[];
  /** 计划模式：模型只读调研并出计划，批准后才执行（持久化在主进程注册表） */
  planMode: boolean;
  /** 草稿会话：仅本地占位，不进注册表；首次发送消息时才真正创建（Finch 式懒创建） */
  draft?: boolean;
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
  planMode?: boolean;
  planFile?: string | null;
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
  /** 轻量通知（定时任务触发等）：自动消失，点击可跳到对应会话 */
  notice: { text: string; sessionId?: string } | null;

  init(): Promise<void>;
  createSession(mode: SessionMode, cwd?: string): Promise<string>;
  /** 草稿会话落盘：首次发送消息时才真正创建并写入历史，返回正式 sessionId */
  materializeDraft(draftId: string): Promise<string>;
  openSession(entry: RegistrySession): Promise<void>;
  openSessionById(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  setActive(id: string): void;
  sendPrompt(text: string, images?: ImageAttachment[]): Promise<void>;
  abort(): Promise<void>;
  setModel(ref: ModelRef): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  setPlanMode(enabled: boolean): Promise<void>;
  replyPermission(requestId: string, approved: boolean): void;
  replyQuestion(requestId: string, answers: Record<string, string>): void;
  applyHostEvent(event: HostEvent): void;
  refreshModels(): Promise<void>;
  /** 重新拉取会话注册表（定时任务新建会话 / sessions.changed 事件后调用） */
  refreshSessions(): Promise<void>;
  saveSettings(patch: Partial<AppSettings>): Promise<void>;
}

// ---------------------------------------------------------------------------
// pi 事件规整
// ---------------------------------------------------------------------------

interface PiContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  /** image 块字段（pi ImageContent：base64 内联） */
  data?: string;
  mimeType?: string;
}

/**
 * pi 消息的 content 块按数组顺序天然带时间序（思考/正文/工具调用交错），
 * 直接按序转段：相邻同类合并，工具调用相邻的并入同一批。
 * toolResults 用于历史回放时回填工具输出。
 */
function contentToSegments(content: unknown, toolResults?: Map<string, { text: string; isError: boolean }>): Segment[] {
  if (!Array.isArray(content)) return [];
  const out: Segment[] = [];
  for (const b of content as PiContentBlock[]) {
    if (b.type === "thinking" && b.thinking) {
      const last = out[out.length - 1];
      if (last?.kind === "thinking") last.text += b.thinking;
      else out.push({ kind: "thinking", id: nextMsgId(), text: b.thinking, done: true });
    } else if (b.type === "text" && b.text) {
      const last = out[out.length - 1];
      if (last?.kind === "text") last.text += b.text;
      else out.push({ kind: "text", id: nextMsgId(), text: b.text });
    } else if (b.type === "toolCall" && b.id && b.name) {
      const res = toolResults?.get(b.id);
      const last = out[out.length - 1];
      const call: ToolCallState = {
        id: b.id,
        name: b.name,
        args: b.arguments,
        status: res ? (res.isError ? "error" : "done") : "running",
        output: res?.text ?? "",
      };
      if (last?.kind === "tools") last.calls.push(call);
      else out.push({ kind: "tools", id: nextMsgId(), calls: [call] });
    }
  }
  return out;
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

/**
 * 宿主事件订阅句柄（模块级）。
 * StrictMode 下 App 的挂载 effect 会跑两次，init() 随之重入；
 * 订阅必须幂等，否则每个 HostEvent 被应用两遍（回复气泡重复、用量翻倍）。
 */
let unsubscribeHostEvents: (() => void) | null = null;

/** 解除宿主事件订阅（App 卸载 / StrictMode 重挂载清理时调用） */
export function teardownHostEvents(): void {
  unsubscribeHostEvents?.();
  unsubscribeHostEvents = null;
}

/** 找到或创建当前正在流式输出的 assistant 消息 */
function ensureStreamingMessage(session: SessionState): ChatMessage {
  const last = session.messages[session.messages.length - 1];
  if (last && last.role === "assistant" && last.streaming) return last;
  const msg: ChatMessage = {
    id: nextMsgId(),
    role: "assistant",
    segments: [],
    streaming: true,
  };
  session.messages.push(msg);
  return msg;
}

/**
 * 追加一段 delta 到当前流式消息：与上一段同类则续写，否则另起新段。
 * 这是"输出单向无插叙"的关键——段的顺序就是事件到达顺序。
 */
function appendDelta(session: SessionState, kind: "text" | "thinking", delta: string): void {
  const msg = ensureStreamingMessage(session);
  const last = msg.segments[msg.segments.length - 1];
  if (last?.kind === kind) {
    last.text += delta;
    if (last.kind === "thinking") last.done = false;
  } else {
    msg.segments.push(
      kind === "thinking"
        ? { kind: "thinking", id: nextMsgId(), text: delta, done: false }
        : { kind: "text", id: nextMsgId(), text: delta },
    );
  }
}

/** 消息是否完全没有内容（空占位判定） */
function isEmptyMessage(m: ChatMessage): boolean {
  return !m.segments.some(
    (s) =>
      ((s.kind === "text" || s.kind === "thinking") && s.text.trim()) || (s.kind === "tools" && s.calls.length > 0),
  );
}

/** 收尾悬挂的流式消息：空占位直接丢弃，已有内容则定格（运行结束/出错时调用） */
function settleStreamingTail(session: SessionState): void {
  const last = session.messages[session.messages.length - 1];
  if (last?.role !== "assistant" || !last.streaming) return;
  if (isEmptyMessage(last)) {
    session.messages.pop();
  } else {
    for (const s of last.segments) if (s.kind === "thinking") s.done = true;
    last.streaming = false;
  }
}

function applySessionEvent(session: SessionState, event: Record<string, unknown>): void {
  const type = event.type as string;
  switch (type) {
    case "message_update": {
      const ame = (event as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
      if (!ame) break;
      if (ame.type === "text_delta" && ame.delta) {
        appendDelta(session, "text", ame.delta);
      } else if (ame.type === "thinking_delta" && ame.delta) {
        appendDelta(session, "thinking", ame.delta);
      }
      break;
    }
    case "message_end": {
      const msg = event.message as { role?: string; content?: unknown };
      if (msg.role === "assistant") {
        const cur = ensureStreamingMessage(session);
        if (cur.segments.length === 0 && Array.isArray(msg.content)) {
          // 非流式提供商兜底：没有 delta 事件，从最终 content 按序重建段
          cur.segments = contentToSegments(msg.content);
        }
        for (const s of cur.segments) if (s.kind === "thinking") s.done = true;
        cur.streaming = false;
      }
      break;
    }
    case "tool_execution_start": {
      const cur = ensureStreamingMessage(session);
      const call: ToolCallState = {
        id: event.toolCallId as string,
        name: event.toolName as string,
        args: event.args,
        status: "running",
        output: "",
      };
      const last = cur.segments[cur.segments.length - 1];
      if (last?.kind === "tools") last.calls.push(call);
      else cur.segments.push({ kind: "tools", id: nextMsgId(), calls: [call] });
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
      // 运行结束（含 abort）：空占位消息不再转圈，有内容的定格
      settleStreamingTail(session);
      break;
  }
}

function findToolCall(session: SessionState, id: string): ToolCallState | undefined {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m?.role !== "assistant") continue;
    for (let j = m.segments.length - 1; j >= 0; j--) {
      const seg = m.segments[j];
      if (seg?.kind === "tools") {
        const tc = seg.calls.find((t) => t.id === id);
        if (tc) return tc;
      }
    }
    if (!m.streaming) break;
  }
  return undefined;
}

/** pi 持久化消息 → UI 消息（恢复会话时回放）。content 块有序，段按原顺序还原。导出供单测使用 */
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
      const blocks = Array.isArray(m.content) ? (m.content as PiContentBlock[]) : [];
      const text = blocks
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n");
      // 图片附件块还原成 images（否则重新打开会话后历史里的图片会丢失）
      const images = blocks
        .filter((b) => b.type === "image" && b.data)
        .map((b, i) => ({
          name: `image-${i + 1}`,
          mimeType: b.mimeType || "image/png",
          data: b.data as string,
        }));
      if (text || images.length > 0) {
        out.push({
          id: nextMsgId(),
          role: "user",
          segments: text ? [{ kind: "text", id: nextMsgId(), text }] : [],
          ...(images.length ? { images } : {}),
          streaming: false,
        });
      }
    } else if (m.role === "assistant") {
      const segments = contentToSegments(m.content, toolResults);
      if (segments.length > 0) {
        out.push({ id: nextMsgId(), role: "assistant", segments, streaming: false });
      }
    }
  }
  return out;
}

/** 浅拷贝 SessionState + messages 数组后再修改，保证引用变化触发渲染 */
function touchSession(s: StoreState, sessionId: string, mutate: (draft: SessionState) => void): StoreState {
  const old = s.sessions[sessionId];
  if (!old) return s;
  const draft: SessionState = { ...old, messages: [...old.messages], usage: { ...old.usage } };
  mutate(draft);
  return { ...s, sessions: { ...s.sessions, [sessionId]: draft } };
}

/** 切换/新建会话时丢弃其他空草稿（保留 keepId），返回 sessions/sessionOrder 局部更新 */
function pruneDrafts(s: StoreState, keepId: string | null): Pick<StoreState, "sessions" | "sessionOrder"> {
  const stale = Object.values(s.sessions).filter((x) => x.draft && x.meta.id !== keepId);
  if (stale.length === 0) return { sessions: s.sessions, sessionOrder: s.sessionOrder };
  const drop = new Set(stale.map((x) => x.meta.id));
  const sessions = Object.fromEntries(Object.entries(s.sessions).filter(([id]) => !drop.has(id)));
  return { sessions, sessionOrder: s.sessionOrder.filter((id) => !drop.has(id)) };
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
  notice: null,

  async init() {
    // 订阅放在任何 await 之前并保持幂等：两次 init 交错时也只会有一个监听器
    if (!unsubscribeHostEvents) {
      unsubscribeHostEvents = window.spcode.onEvent((event) => get().applyHostEvent(event));
    }
    const settings = await window.spcode.getSettings();
    set({ settings });
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

  async refreshSessions() {
    const registry = await window.spcode.listSessions().catch(() => null);
    if (registry) set({ registrySessions: registry });
  },

  async openSessionById(id) {
    const existing = get().sessions[id];
    if (existing) {
      set((s) => ({ activeSessionId: id, ...pruneDrafts(s, id) }));
      return;
    }
    const entry = get().registrySessions.find((r) => r.id === id);
    if (entry) await get().openSession(entry);
  },

  async createSession(mode, cwd) {
    // 同范围已有空草稿：直接激活复用，避免连点产生一堆空会话（Finch 式懒创建）
    const dup = Object.values(get().sessions).find(
      (s) => s.draft && s.meta.mode === mode && (s.meta.cwd || "") === (cwd ?? ""),
    );
    if (dup) {
      set({ activeSessionId: dup.meta.id });
      return dup.meta.id;
    }
    const settings = get().settings;
    const id = `draft-${crypto.randomUUID()}`;
    const now = Date.now();
    const model = settings?.defaultModel ?? null;
    const thinkingLevel = settings?.defaultThinkingLevel ?? "off";
    const meta: SessionMeta = {
      id,
      mode,
      cwd: cwd ?? "",
      title: mode === "chat" ? "新聊天" : cwd ? baseName(cwd) || "新项目" : "新项目",
      model,
      thinkingLevel,
      createdAt: now,
      updatedAt: now,
    };
    const modelInfo = get().models.find((m) => m.provider === model?.provider && m.modelId === model?.modelId);
    const session: SessionState = {
      meta,
      messages: [],
      running: false,
      usage: { ...EMPTY_USAGE },
      lastUsage: null,
      supportedThinkingLevels: modelInfo?.thinkingLevels ?? [],
      todos: [],
      planMode: false,
      draft: true,
    };
    // 草稿只进内存、不进注册表：侧栏不出现，发送第一条消息时才真正创建（materializeDraft）
    set((s) => {
      const pruned = pruneDrafts(s, id);
      return {
        sessions: { ...pruned.sessions, [id]: session },
        sessionOrder: [id, ...pruned.sessionOrder],
        activeSessionId: id,
      };
    });
    return id;
  },

  async materializeDraft(draftId) {
    const draft = get().sessions[draftId];
    if (!draft?.draft) return draftId;
    const id = crypto.randomUUID();
    const info = await window.spcode.command<{
      model: ModelRef | null;
      thinkingLevel: string;
      supportedThinkingLevels: string[];
      planMode?: boolean;
    }>({
      type: "session.create",
      payload: {
        sessionId: id,
        mode: draft.meta.mode,
        cwd: draft.meta.cwd,
        model: draft.meta.model ?? undefined,
        thinkingLevel: draft.meta.thinkingLevel,
      },
    });
    const now = Date.now();
    set((s) => {
      const pruned = pruneDrafts(s, draftId);
      const sessions = { ...pruned.sessions };
      delete sessions[draftId];
      sessions[id] = {
        ...draft,
        draft: undefined,
        meta: { ...draft.meta, id, model: info.model, thinkingLevel: info.thinkingLevel, updatedAt: now },
        supportedThinkingLevels: info.supportedThinkingLevels ?? draft.supportedThinkingLevels,
      };
      return {
        sessions,
        sessionOrder: [id, ...pruned.sessionOrder.filter((x) => x !== draftId)],
        activeSessionId: s.activeSessionId === draftId ? id : s.activeSessionId,
        registrySessions: [
          {
            id,
            mode: draft.meta.mode,
            cwd: draft.meta.cwd,
            title: draft.meta.title,
            model: info.model,
            thinkingLevel: info.thinkingLevel,
            sessionFile: null,
            planMode: draft.planMode,
            planFile: null,
            createdAt: draft.meta.createdAt,
            updatedAt: now,
          },
          ...s.registrySessions,
        ],
      };
    });
    // 草稿期开了计划模式：落盘后同步给宿主
    if (draft.planMode) {
      await window.spcode
        .command({ type: "session.setPlanMode", payload: { sessionId: id, enabled: true } })
        .catch(() => {});
    }
    return id;
  },

  async openSession(entry) {
    // 已激活的会话直接切换
    if (get().sessions[entry.id]) {
      set((s) => ({ activeSessionId: entry.id, ...pruneDrafts(s, entry.id) }));
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
      planMode?: boolean;
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
      lastUsage: null,
      supportedThinkingLevels: info.supportedThinkingLevels ?? [],
      todos: [],
      planMode: info.planMode ?? entry.planMode ?? false,
    };
    // 历史消息由随后的 session.history 事件填充
    set((s) => {
      const pruned = pruneDrafts(s, entry.id);
      return {
        sessions: { ...pruned.sessions, [entry.id]: session },
        sessionOrder: [entry.id, ...pruned.sessionOrder.filter((x) => x !== entry.id)],
        activeSessionId: entry.id,
      };
    });
  },

  async deleteSession(id) {
    // 草稿会话没有宿主/注册表记录，只清理本地
    if (!get().sessions[id]?.draft) await window.spcode.removeSession(id);
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
    // 切换时丢弃未发送的空草稿（保留目标会话本身）
    set((s) => ({ activeSessionId: id, ...pruneDrafts(s, id || null) }));
  },

  async sendPrompt(text, images) {
    const activeId = get().activeSessionId;
    if (!activeId || (!text.trim() && !images?.length)) return;
    // 草稿会话：首次发送时才真正创建并写入历史（避免空会话刷屏侧栏）
    let sessionId = activeId;
    if (get().sessions[sessionId]?.draft) {
      try {
        sessionId = await get().materializeDraft(sessionId);
      } catch (e) {
        set({ lastError: e instanceof Error ? e.message : String(e) });
        return;
      }
    }
    set((s) =>
      touchSession(s, sessionId, (draft) => {
        draft.messages.push({
          id: nextMsgId(),
          role: "user",
          segments: [{ kind: "text", id: nextMsgId(), text }],
          ...(images?.length ? { images } : {}),
          streaming: false,
        });
        // 立即创建 assistant 流式占位：加载动画随点击发送同时出现，
        // 不等引擎首个 text/thinking delta（思考型模型首 token 可能数秒）
        draft.messages.push({
          id: nextMsgId(),
          role: "assistant",
          segments: [],
          streaming: true,
        });
        draft.running = true;
        if (!draft.messages.some((m) => m.role === "user" && messageText(m) !== text)) {
          draft.meta = { ...draft.meta, title: cleanSessionTitle(text) || "图片消息" };
        }
      }),
    );
    // 侧栏标题即时兜底更新（AI RenameSession 之后可覆盖）
    set((s) => ({
      registrySessions: s.registrySessions.map((r) =>
        r.id === sessionId && (r.title === "新聊天" || r.title === "新项目" || r.title === baseName(r.cwd))
          ? { ...r, title: cleanSessionTitle(text) || "图片消息", updatedAt: Date.now() }
          : r,
      ),
    }));
    try {
      await window.spcode.command({
        type: "session.prompt",
        payload: { sessionId, text, ...(images?.length ? { images } : {}) },
      });
    } catch (e) {
      set((s) =>
        touchSession(s, sessionId, (draft) => {
          draft.running = false;
          settleStreamingTail(draft);
        }),
      );
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  async abort() {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    if (get().sessions[activeSessionId]?.draft) return; // 草稿没有宿主实例
    await window.spcode.command({ type: "session.abort", payload: { sessionId: activeSessionId } });
  },

  async setModel(ref) {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    // 草稿会话：只记本地，落盘时随 session.create 一起传给宿主
    if (get().sessions[activeSessionId]?.draft) {
      set((s) =>
        touchSession(s, activeSessionId, (draft) => {
          draft.meta = { ...draft.meta, model: ref };
          draft.supportedThinkingLevels =
            get().models.find((m) => m.provider === ref.provider && m.modelId === ref.modelId)?.thinkingLevels ?? [];
        }),
      );
      void get().saveSettings({ defaultModel: ref });
      return;
    }
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
    // 草稿会话：只记本地，落盘时随 session.create 一起传给宿主
    if (get().sessions[activeSessionId]?.draft) {
      set((s) =>
        touchSession(s, activeSessionId, (draft) => {
          draft.meta = { ...draft.meta, thinkingLevel: level };
        }),
      );
      return;
    }
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

  async setPlanMode(enabled) {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    // 草稿会话：只记本地，落盘后由 materializeDraft 同步给宿主
    if (get().sessions[activeSessionId]?.draft) {
      set((s) =>
        touchSession(s, activeSessionId, (draft) => {
          draft.planMode = enabled;
        }),
      );
      return;
    }
    // 先本地切换（按钮/提示条即时响应），宿主的 session.planmode 事件随后到达，幂等
    set((s) =>
      touchSession(s, activeSessionId, (draft) => {
        draft.planMode = enabled;
      }),
    );
    try {
      await window.spcode.command({ type: "session.setPlanMode", payload: { sessionId: activeSessionId, enabled } });
    } catch (e) {
      // 失败回滚本地状态
      set((s) =>
        touchSession(s, activeSessionId, (draft) => {
          draft.planMode = !enabled;
        }),
      );
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
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
    // 带副作用的事件在 set 之外处理：刷新注册表列表 / 弹通知
    if (event.type === "sessions.changed") {
      void get().refreshSessions();
      return;
    }
    if (event.type === "schedule.fired") {
      set({ notice: { text: `定时任务「${event.name}」已启动新会话`, sessionId: event.sessionId } });
      void get().refreshSessions();
      return;
    }
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
            draft.lastUsage = event.usage;
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
        case "session.planmode":
          // ExitPlanMode 批准后宿主也会推这个事件；与本地乐观更新幂等
          return touchSession(s, event.sessionId, (draft) => {
            draft.planMode = event.enabled;
          });
        case "session.renamed": {
          // AI 起的标题：更新会话元信息 + 侧栏注册表条目
          const withMeta = touchSession(s, event.sessionId, (draft) => {
            draft.meta = { ...draft.meta, title: event.title };
          });
          return {
            ...withMeta,
            registrySessions: withMeta.registrySessions.map((r) =>
              r.id === event.sessionId ? { ...r, title: event.title, updatedAt: Date.now() } : r,
            ),
          };
        }
        case "question.request": {
          if (s.pendingQuestions.some((q) => q.requestId === event.request.requestId)) return s;
          return { ...s, pendingQuestions: [...s.pendingQuestions, event.request] };
        }
        case "permission.request": {
          if (s.pendingPermissions.some((p) => p.requestId === event.request.requestId)) return s;
          return { ...s, pendingPermissions: [...s.pendingPermissions, event.request] };
        }
        case "host.error":
          // fatal=宿主进程退出才影响就绪态；prompt 失败等普通错误只记 lastError（评审 P1-2）
          return event.fatal
            ? { ...s, lastError: event.message, hostReady: false }
            : { ...s, lastError: event.message };
        default:
          return s;
      }
    });
  },
}));
