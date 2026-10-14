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

export type ToolRisk = "readonly" | "write" | "outward" | "danger";

export type PermissionMode = "ask" | "act";

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  toolName: string;
  args: unknown;
  risk: ToolRisk;
  /** 该命令是否将在 OS 沙盒内执行（渲染层据此标注「沙盒内」；false/缺省 = 无沙盒兜底） */
  sandboxed?: boolean;
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
  | {
      id: string;
      type: "session.create";
      payload: {
        sessionId: string;
        mode: SessionMode;
        cwd: string;
        model?: ModelRef;
        thinkingLevel?: string /** 定时任务等场景：关闭标题自动化（标题由调用方指定） */;
        noTitleAutomation?: boolean;
      };
    }
  | {
      id: string;
      type: "session.open";
      payload: {
        sessionId: string;
        sessionFile: string;
        cwd: string /** 注册表里的计划模式状态（主进程注入，用于恢复计划态） */;
        planMode?: boolean;
      };
    }
  | { id: string; type: "session.prompt"; payload: { sessionId: string; text: string; images?: ImageAttachment[] } }
  | { id: string; type: "session.setPlanMode"; payload: { sessionId: string; enabled: boolean } }
  | { id: string; type: "session.abort"; payload: { sessionId: string } }
  | { id: string; type: "session.setModel"; payload: { sessionId: string; model: ModelRef } }
  | { id: string; type: "session.setThinkingLevel"; payload: { sessionId: string; level: string } }
  | { id: string; type: "session.dispose"; payload: { sessionId: string } }
  | {
      id: string;
      /** 非活动会话宿主侧休眠：宽限期后释放 AgentSession；运行中的会话会被拒绝 */
      type: "session.hibernate";
      payload: { sessionId: string };
    }
  | {
      id: string;
      /** 唤醒（幂等）：宿主已有实例直接返回 info，否则按 sessionFile 恢复并回放历史 */
      type: "session.activate";
      payload: { sessionId: string; sessionFile: string; cwd: string; planMode?: boolean };
    }
  | { id: string; type: "models.list" }
  | { id: string; type: "models.catalog" }
  | { id: string; type: "memory.read" }
  /** AI 生成主题：可选指定模型（默认取设置里的默认模型，缺省退回可用列表首个） */
  | { id: string; type: "theme.generate"; payload: { description: string; model?: ModelRef } }
  | { type: "memory.setDistillEnabled"; payload: { enabled: boolean } }
  /** 高级搜索配置下发（设置页变更后推送；宿主就绪时重推） */
  | { type: "search.setAdvancedConfig"; payload: { config: AdvancedSearchConfig | null } }
  /** 沙盒设置下发（设置页变更后推送；宿主就绪时重推）。对已创建会话不生效，新会话生效 */
  | { type: "sandbox.setConfig"; payload: { config: SandboxSettings } }
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
  /**
   * 权限请求已在任一端裁决（远程控制 M3 双端撤卡）：另一端据此关闭同 requestId 的批准卡。
   * by = 裁决来源端（"local" 桌面 / "remote" 远程设备）；由主进程在 replyPermission 成功后广播
   */
  | { type: "permission.resolved"; requestId: string; approved: boolean; by: "local" | "remote" }
  | { type: "question.request"; request: QuestionRequest }
  /** 会话注册表发生变化（如定时任务新建会话）：渲染进程应重新拉取列表 */
  | { type: "sessions.changed" }
  /** 定时任务触发：已为其创建会话并注入 prompt */
  | { type: "schedule.fired"; taskId: string; name: string; sessionId: string }
  /** fatal=true 表示宿主进程已退出（渲染层据此置 hostReady=false）；普通错误（如 prompt 失败）不影响就绪态 */
  | { type: "host.error"; message: string; fatal?: boolean };

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

/** 人性化周期描述（UI 与通知同口径——评审 P2-5：收敛原 scheduler/SchedulePage 双实现） */
export function describeSchedule(task: ScheduleTask): string {
  const hm = `${String(task.hour).padStart(2, "0")}:${String(task.minute).padStart(2, "0")}`;
  switch (task.frequency) {
    case "once":
      return task.runAt
        ? `单次 · ${new Date(task.runAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
        : "单次";
    case "hourly":
      return `每小时 · 第 ${task.minute} 分`;
    case "daily":
      return `每天 ${hm}`;
    case "weekday":
      return `工作日 ${hm}`;
    case "weekly":
      return `每周${"日一二三四五六"[task.weekday ?? 1]} ${hm}`;
  }
}

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
  /** 应用版本号（设置页更新通道开关展示默认值用） */
  getAppVersion: "spcode:get-app-version",
  /** renderer -> main (invoke)：高级搜索配置测试连接（发真实请求验证） */
  searchTest: "spcode:search-test",
  /** renderer -> main (invoke)：会话标题+正文全文搜索 */
  searchSessions: "spcode:search-sessions",
  /** renderer -> main (invoke)：远程控制状态/开关/配对/解绑 */
  remoteStatus: "spcode:remote-status",
  remoteSetEnabled: "spcode:remote-set-enabled",
  remoteRegeneratePairing: "spcode:remote-regenerate-pairing",
  remoteUnpairDevice: "spcode:remote-unpair-device",
  /** renderer -> main (invoke)：飞书通道解绑授权用户（open_id） */
  remoteFeishuUnbind: "spcode:remote-feishu-unbind",
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

/** 高级搜索协议预设：tavily / 博查 bocha / custom（custom 用 responseSample 推断响应映射） */
export type AdvancedSearchProtocol = "tavily" | "bocha" | "custom";

export interface AdvancedSearchConfig {
  protocol: AdvancedSearchProtocol;
  /** 完整端点 URL（预设切换时 UI 自动填默认值） */
  baseUrl: string;
  apiKey: string;
  /** custom 专用：用户粘贴的响应示例 JSON，保存时推断结果数组路径与字段映射 */
  responseSample?: string;
  /** custom 专用：从 responseSample 推断出的映射（结果数组点路径 + 字段名），推断失败为空 */
  mapping?: AdvancedSearchMapping | null;
}

export interface AdvancedSearchMapping {
  /** 结果数组的点路径，如 "data.webPages.value"；空字符串表示响应顶层即数组 */
  resultsPath: string;
  titleField: string;
  urlField: string;
  /** 摘要字段可为空（示例里没有可识别的摘要字段时） */
  snippetField: string;
}

import type { RemoteSettings } from "./remote.js";

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
  /** 接收测试版更新；undefined = 跟随当前版本形态（beta 版收 beta，稳定版只收稳定） */
  betaUpdates?: boolean;
  /** 自动记忆蒸馏：每轮对话结束后自动整理长期记忆（会消耗少量 token，可关） */
  memoryDistill: boolean;
  /** 模型行悬浮时显示配额卡片 */
  quickQuota: boolean;
  /** 停用的供应商与单个模型（模型页开关） */
  disabledProviders: string[];
  disabledModels: string[];
  /** 导入的字体文件名（存于 ~/.spcode/fonts/，family 名为展示名） */
  uiFontFile: string;
  monoFontFile: string;
  /** 高级搜索（配置了才对会话生效；未配置时只用内置 Bing WebSearch） */
  advancedSearch: AdvancedSearchConfig | null;
  /** 远程控制（手机 PWA）：局域网 HTTP+WS 服务开关/端口（null = 随机端口）与 relay 地址 */
  remote: RemoteSettings;
  /** 命令沙盒：bash 命令在 OS 级边界内执行（macOS Seatbelt / Linux bubblewrap） */
  sandbox: SandboxSettings;
}

/**
 * 命令沙盒设置。语义对齐 @anthropic-ai/sandbox-runtime 的配置模型：
 * 文件系统写是 allow-only（只有 cwd/临时目录/缓存与 extraAllowWrite 可写），
 * 网络是 allow-only（只有 allowedDomains 放行）。
 */
export interface SandboxSettings {
  /** 总开关；关掉则回退到纯审批网关（每条写类命令都弹窗） */
  enabled: boolean;
  /** 沙盒内 readonly/write 级命令免审批；danger/outward 级仍然弹窗 */
  autoAllow: boolean;
  network: {
    /** 放行的域名（支持 *.example.com 与 example.com:443 端口语法） */
    allowedDomains: string[];
    /** 显式拒绝的域名（优先于 allowedDomains） */
    deniedDomains: string[];
  };
  filesystem: {
    /** 额外允许写入的绝对路径（开发缓存之外的特殊需求） */
    extraAllowWrite: string[];
    /** 额外禁止读取的路径（在默认敏感清单之上追加） */
    extraDenyRead: string[];
    /** 额外禁止写入的路径（只对工作目录等可写区域内有意义） */
    extraDenyWrite: string[];
  };
}

/** 默认网络白名单：覆盖 JS/Python/Rust/Go/JVM 包管理与 GitHub */
export const DEFAULT_SANDBOX_ALLOWED_DOMAINS: string[] = [
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "registry.npmjs.org",
  "*.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "*.pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "*.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "repo.maven.apache.org",
  "plugins.gradle.org",
  "services.gradle.org",
];

export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
  enabled: true,
  autoAllow: true,
  network: {
    allowedDomains: DEFAULT_SANDBOX_ALLOWED_DOMAINS,
    deniedDomains: [],
  },
  filesystem: {
    extraAllowWrite: [],
    extraDenyRead: [],
    extraDenyWrite: [],
  },
};

export interface CustomTheme {
  name: string;
  /** 明暗基底。注意：代码块 shiki 高亮主题钉死在 MessageItem.tsx 的 SHIKI_THEME（当前 github-dark），
   *  支持浅色基底时需联动切换那里的高亮方案（评审 N3） */
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
  memoryDistill: true,
  quickQuota: true,
  disabledProviders: [],
  disabledModels: [],
  uiFontFile: "",
  monoFontFile: "",
  advancedSearch: null,
  sandbox: DEFAULT_SANDBOX_SETTINGS,
  remote: {
    enabled: false,
    port: null,
    relayUrl: null,
    tailscale: false,
    pushEnabled: false,
    feishu: { enabled: false, appId: "", appSecret: "" },
  },
};

/** Spcode 全局数据目录（记忆、设置、用量、会话索引都放在这里） */
export const SPCODE_HOME_DIRNAME = ".spcode";

/**
 * 更新通道裁决（electron-updater 的 allowPrerelease 取值）：
 * 显式设置优先；未设置时跟随当前版本形态——当前是 beta 版就收 beta 更新，
 * 当前是稳定版就只收稳定版（与 electron-updater 内置默认一致）。
 */
export function resolveAllowPrerelease(pref: boolean | undefined | null, currentVersion: string): boolean {
  if (typeof pref === "boolean") return pref;
  // 去掉 v 前缀与构建元数据（+sha 等），核心版本号后带 -xxx 即预发布
  const core = currentVersion.replace(/^v/i, "").split("+")[0] ?? "";
  return /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(core);
}

// ---------------------------------------------------------------------------
// 远程控制协议（type-only 再导出：本包在运行时以 TS 源码被 Node 直接加载，
// 运行时的跨文件相对导入会因 ./x.js → x.ts 解析失败，故只允许 type-only 重导出）
// ---------------------------------------------------------------------------

export type * from "./remote.js";
