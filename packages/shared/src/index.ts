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

/** 图片附件（base64 内联，随 prompt 传给引擎；对应 pi 的 ImageContent） */
export interface ImageAttachment {
  name: string;
  mimeType: string;
  data: string;
}

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
  | { id: string; type: "session.create"; payload: { sessionId: string; mode: SessionMode; cwd: string; model?: ModelRef; thinkingLevel?: string; /** 定时任务等场景：关闭标题自动化（标题由调用方指定） */ noTitleAutomation?: boolean } }
  | { id: string; type: "session.open"; payload: { sessionId: string; sessionFile: string; cwd: string; /** 注册表里的计划模式状态（主进程注入，用于恢复计划态） */ planMode?: boolean } }
  | { id: string; type: "session.prompt"; payload: { sessionId: string; text: string; images?: ImageAttachment[] } }
  | { id: string; type: "session.setPlanMode"; payload: { sessionId: string; enabled: boolean } }
  | { id: string; type: "session.abort"; payload: { sessionId: string } }
  | { id: string; type: "session.setModel"; payload: { sessionId: string; model: ModelRef } }
  | { id: string; type: "session.setThinkingLevel"; payload: { sessionId: string; level: string } }
  | { id: string; type: "session.dispose"; payload: { sessionId: string } }
  | { id: string; type: "models.list" }
  | { id: string; type: "models.catalog" }
  | { id: string; type: "memory.read" }
  | { id: string; type: "theme.generate"; payload: { description: string } }
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
  /** AI 通过 RenameSession 工具主动起的会话标题 */
  | { type: "session.renamed"; sessionId: string; title: string }
  /** 计划模式开关变化（用户在 Composer 切换 / ExitPlanMode 批准后关闭） */
  | { type: "session.planmode"; sessionId: string; enabled: boolean }
  /** WritePlan 工具落盘了计划文件（主进程回填 planFile 用） */
  | { type: "session.plan"; sessionId: string; path: string }
  | { type: "permission.request"; request: PermissionRequest }
  | { type: "question.request"; request: QuestionRequest }
  /** 会话注册表发生变化（如定时任务新建会话）：渲染进程应重新拉取列表 */
  | { type: "sessions.changed" }
  /** 定时任务触发：已为其创建会话并注入 prompt */
  | { type: "schedule.fired"; taskId: string; name: string; sessionId: string }
  | { type: "host.error"; message: string };

// ---------------------------------------------------------------------------
// 会话搜索
// ---------------------------------------------------------------------------

export interface SessionSearchHit {
  role: "user" | "assistant";
  timestamp: number;
  /** 命中处前后各约 40 字的上下文摘要 */
  snippet: string;
}

/** 一条搜索命中（会话级）：标题命中或正文命中；渲染进程按 id 关联本地注册表条目 */
export interface SessionSearchResultItem {
  id: string;
  titleMatch: boolean;
  hits: SessionSearchHit[];
}

// ---------------------------------------------------------------------------
// 定时任务
// ---------------------------------------------------------------------------

export type ScheduleFrequency = "once" | "hourly" | "daily" | "weekday" | "weekly";

/** 触发目标：新建聊天会话 / 在指定项目目录下新建项目会话 */
export type ScheduleTarget = { kind: "chat" } | { kind: "project"; cwd: string };

export interface ScheduleTask {
  id: string;
  name: string;
  prompt: string;
  target: ScheduleTarget;
  frequency: ScheduleFrequency;
  /** 0-23（once 不用） */
  hour: number;
  /** 0-59 */
  minute: number;
  /** 0-6，0=周日（weekly 用） */
  weekday?: number;
  /** once 专用：触发时间戳（毫秒） */
  runAt?: number;
  enabled: boolean;
  lastRunAt?: number;
  lastStatus?: "ok" | "error";
  lastError?: string;
  createdAt: number;
}

/** 新建/编辑定时任务的输入（id/运行状态由系统维护） */
export type ScheduleTaskInput = Omit<ScheduleTask, "id" | "createdAt" | "lastRunAt" | "lastStatus" | "lastError">;

/** 兜底标题清洗：压平换行/多余空白，截断到 30 字（Finch 同款思路：首条用户消息推导） */
export function cleanSessionTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 30);
}

/** 取路径最后一段（跨平台：同时认 / 与 \——渲染进程没有 node:path，统一从这里拿） */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

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
  usageAggregate: "spcode:usage-aggregate",
  quotaQuery: "spcode:quota-query",
  /** renderer -> main (invoke)：字体与主题文件操作 */
  pickFontFile: "spcode:pick-font-file",
  getFontData: "spcode:get-font-data",
  pickThemeFile: "spcode:pick-theme-file",
  /** renderer -> main (invoke)：选择项目文件夹 / 图片附件 */
  pickDirectory: "spcode:pick-directory",
  pickImages: "spcode:pick-images",
  /** renderer -> main (invoke)：在 Finder/资源管理器中显示路径 */
  revealPath: "spcode:reveal-path",
  /** renderer -> main (invoke)：读取/写入应用设置 */
  getSettings: "spcode:get-settings",
  setSettings: "spcode:set-settings",
  /** renderer -> main (invoke)：会话标题+正文全文搜索 */
  searchSessions: "spcode:search-sessions",
  /** renderer -> main (invoke)：定时任务 CRUD 与立即试运行 */
  scheduleList: "spcode:schedule-list",
  scheduleCreate: "spcode:schedule-create",
  scheduleUpdate: "spcode:schedule-update",
  scheduleDelete: "spcode:schedule-delete",
  scheduleRunNow: "spcode:schedule-run-now",
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
  /** 模型行悬浮时显示配额卡片 */
  quickQuota: boolean;
  /** 停用的供应商与单个模型（模型页开关） */
  disabledProviders: string[];
  disabledModels: string[];
  /** 导入的字体文件名（存于 ~/.spcode/fonts/，family 名为展示名） */
  uiFontFile: string;
  monoFontFile: string;
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
  quickQuota: true,
  disabledProviders: [],
  disabledModels: [],
  uiFontFile: "",
  monoFontFile: "",
};

/** Spcode 全局数据目录（记忆、设置、用量、会话索引都放在这里） */
export const SPCODE_HOME_DIRNAME = ".spcode";
