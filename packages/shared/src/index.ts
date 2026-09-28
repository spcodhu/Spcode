/**
 * Spcode Harness 共享协议与类型。
 *
 * 通信拓扑：
 *   Renderer <—IPC(contextBridge)—> Main <—结构化克隆消息—> AgentHost(utilityProcess)
 *
 * 本文件只放纯类型与常量，禁止引入任何运行时依赖。
 */

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface ModelInfo {
  provider: string;
  modelId: string;
  displayName: string;
  contextWindow: number;
  maxTokens: number;
  /** 支持的思考档位，如 ["off","low","medium","high"]；空数组表示不支持思考 */
  thinkingLevels: string[];
  /** 是否已有可用凭证 */
  available: boolean;
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export type SessionMode = "chat" | "project";

export interface SessionMeta {
  id: string;
  mode: SessionMode;
  /** 项目模式下的工作目录；聊天模式为临时目录 */
  cwd: string;
  title: string;
  model: ModelRef | null;
  thinkingLevel: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Token 用量（与 pi 的 usage 结构对齐）
// ---------------------------------------------------------------------------

export interface UsageSample {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
}

export interface UsageRecord extends UsageSample {
  sessionId: string;
  model: ModelRef;
  timestamp: number;
}

export interface UsageAggregate extends UsageSample {
  count: number;
}

// ---------------------------------------------------------------------------
// 权限
// ---------------------------------------------------------------------------

export type ToolRisk = "readonly" | "write" | "danger";

export type PermissionMode = "ask" | "act";

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  toolName: string;
  args: unknown;
  risk: ToolRisk;
}

// ---------------------------------------------------------------------------
// 结构化提问（AskUserQuestion 工具走这条通道）
// ---------------------------------------------------------------------------

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: QuestionOption[];
}

export interface QuestionRequest {
  requestId: string;
  sessionId: string;
  questions: QuestionItem[];
}

// ---------------------------------------------------------------------------
// 待办（TodoWrite 工具状态）
// ---------------------------------------------------------------------------

export interface TodoItem {
  content: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
}

// ---------------------------------------------------------------------------
// Agent Host 协议（Main ↔ utilityProcess）
// ---------------------------------------------------------------------------

export type HostCommand =
  | { id: string; type: "session.create"; payload: { sessionId: string; mode: SessionMode; cwd: string; model?: ModelRef; thinkingLevel?: string } }
  | { id: string; type: "session.open"; payload: { sessionId: string; sessionFile: string; cwd: string } }
  | { id: string; type: "session.prompt"; payload: { sessionId: string; text: string } }
  | { id: string; type: "session.abort"; payload: { sessionId: string } }
  | { id: string; type: "session.setModel"; payload: { sessionId: string; model: ModelRef } }
  | { id: string; type: "session.setThinkingLevel"; payload: { sessionId: string; level: string } }
  | { id: string; type: "session.dispose"; payload: { sessionId: string } }
  | { id: string; type: "models.list" }
  | { id: string; type: "auth.setApiKey"; payload: { provider: string; apiKey: string } }
  | { id: string; type: "auth.listProviders" }
  | { type: "permission.reply"; payload: { requestId: string; approved: boolean } }
  | { type: "question.reply"; payload: { requestId: string; answers: Record<string, string> } }
  | { type: "shutdown" };

export type HostEvent =
  | { type: "ready" }
  | { type: "response"; id: string; success: boolean; data?: unknown; error?: string }
  | { type: "session.event"; sessionId: string; event: unknown }
  | { type: "session.history"; sessionId: string; messages: unknown[] }
  | { type: "session.usage"; sessionId: string; usage: UsageRecord }
  | { type: "session.todo"; sessionId: string; todos: TodoItem[] }
  | { type: "permission.request"; request: PermissionRequest }
  | { type: "question.request"; request: QuestionRequest }
  | { type: "host.error"; message: string };

/** 分布式 Omit：调用侧构造命令时省略 id（由通道层补发） */
export type HostCommandInput = HostCommand extends infer C
  ? C extends { id: string }
    ? Omit<C, "id"> & { id?: string }
    : never
  : never;

// ---------------------------------------------------------------------------
// Renderer ↔ Main IPC 通道名
// ---------------------------------------------------------------------------

export const IPC = {
  /** renderer -> main (invoke)，payload 为 HostCommand（id 由 main 补发也可） */
  hostCommand: "spcode:host-command",
  /** main -> renderer，payload 为 HostEvent */
  hostEvent: "spcode:host-event",
  /** renderer -> main：权限确认回复 */
  permissionReply: "spcode:permission-reply",
  /** renderer -> main：结构化提问回复 */
  questionReply: "spcode:question-reply",
  /** renderer -> main (invoke)：会话注册表列表/删除 */
  listSessions: "spcode:list-sessions",
  removeSession: "spcode:remove-session",
  /** renderer -> main (invoke)：用量聚合查询（days 可选）/ 厂商配额查询 */
  usageSummary: "spcode:usage-summary",
  quotaQuery: "spcode:quota-query",
  /** renderer -> main (invoke)：选择文件夹，返回路径或 null */
  pickDirectory: "spcode:pick-directory",
  /** renderer -> main (invoke)：读取/写入应用设置 */
  getSettings: "spcode:get-settings",
  setSettings: "spcode:set-settings",
} as const;

// ---------------------------------------------------------------------------
// 应用设置（主进程持久化）
// ---------------------------------------------------------------------------

export interface AppSettings {
  /** 默认模型 */
  defaultModel: ModelRef | null;
  defaultThinkingLevel: string;
  permissionMode: PermissionMode;
  /** UI 主题 id，dark 为内置默认 */
  themeId: string;
  /** 自定义主题 JSON（AI 生成或手工编写） */
  customTheme: CustomTheme | null;
  uiFontFamily: string;
  monoFontFamily: string;
  /** 自动更新开关（需要已配置更新源） */
  autoUpdate: boolean;
}

export interface CustomTheme {
  name: string;
  base: "dark" | "light";
  colors: Record<string, string>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultModel: null,
  defaultThinkingLevel: "medium",
  permissionMode: "ask",
  themeId: "spcode-dark",
  customTheme: null,
  uiFontFamily: "",
  monoFontFamily: "",
  autoUpdate: true,
};

/** Spcode 全局数据目录（记忆、设置、用量、会话索引都放在这里） */
export const SPCODE_HOME_DIRNAME = ".spcode";
