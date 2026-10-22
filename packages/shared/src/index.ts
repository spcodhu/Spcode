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

/**
 * 文件选择结果（IPC pickFiles，Markdown 输入模式「添加文件」用）：
 * - text：文本类文件（扩展名白名单+二进制唿探，≤200KB），渲染层发送时拼进消息文本
 * - image：图片，转 ImageAttachment 走图片附件通道
 * - rejected：二进制/超大/读取失败，渲染层提示并跳过
 */
export type PickedFile =
  | { kind: "text"; name: string; size: number; text: string }
  | { kind: "image"; name: string; mimeType: string; data: string }
  | { kind: "rejected"; name: string; size: number; reason: string };

/**
 * 输入框草稿（按会话持久化， ~/.spcode/composer-drafts.json）。
 * key：正式会话 = sessionId；未落盘的新会话 = "draft:<mode>:<cwd>" 稳定 key
 * （draft 会话对象被清理/重建后仍命中，点加号自动带出）。
 */
export interface ComposerDraft {
  text: string;
  attachments: ImageAttachment[];
  /** 文件附件（MD 模式；含文本内容，发送时拼进消息文本） */
  files: { name: string; size: number; text: string }[];
  /** 输入模式：纯文本 / Markdown */
  inputMode: "plain" | "markdown";
  updatedAt: number;
}

export interface SessionMeta {
  id: string;
  mode: SessionMode;
  /** 项目模式下的工作目录；聊天模式为临时目录 */
  cwd: string;
  title: string;
  titleKind?: "default" | "custom";
  model: ModelRef | null;
  thinkingLevel: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 会话注册表条目（~/.spcode/sessions.json 的行项）：主进程持久化、渲染层/远程端镜像使用。
 * 评审 R3-C12：原在 main/session-registry.ts 定义、store.ts 手工镜像一份，现唯一事实源在这里。
 */
export interface SessionRegistryEntry extends SessionMeta {
  /** pi 会话文件路径（用于恢复），创建后回填 */
  sessionFile: string | null;
  /** 计划模式状态（恢复会话时随 session.open 传给宿主） */
  planMode?: boolean;
  /** WritePlan 落盘的 PLAN.md 路径（~/.spcode/plans/<id>.md），删会话时一并清理 */
  planFile?: string | null;
  /** Fork 来源会话 id（分叉会话才有；UI tooltip 标注用） */
  forkedFrom?: string;
}

/** 宿主 SessionController.info() 的返回类型（session.create/open/fork/setModel 等命令的响应） */
export interface SessionInfo {
  sessionId: string;
  sessionFile: string | null;
  planMode: boolean;
  /** 沙盒状态：active=内核边界生效；disabled=用户关闭；unavailable=平台/依赖不满足 */
  sandbox: { state: "active" | "disabled" | "unavailable"; reason?: string };
  model: ModelRef | null;
  thinkingLevel: string;
  supportedThinkingLevels: string[];
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
  /** 逃生舱请求：模型申请在沙盒外执行（dangerouslyDisableSandbox）。渲染层据此强警示——不受文件/网络边界约束 */
  bypass?: boolean;
}

// ---------------------------------------------------------------------------
// 结构化提问（AskUserQuestion 工具走这条通道）
// ---------------------------------------------------------------------------

import type { QuestionAnswers, QuestionRequest } from "./questions.js";

export type { QuestionAnswer, QuestionAnswers, QuestionItem, QuestionOption, QuestionRequest } from "./questions.js";
export {
  buildQuestionAnswers,
  dismissQuestionAnswers,
  formatQuestionAnswer,
  formatQuestionAnswers,
  validateQuestionAnswers,
} from "./questions.js";

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
  | { type: "locale.set"; payload: { locale: import("./i18n/types.js").Locale } }
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
  | {
      id: string;
      /** Fork 会话：复制源会话的完整上下文到新会话（新 id），两会话从此独立演进 */
      type: "session.fork";
      payload: {
        sourceSessionId: string;
        newSessionId: string;
        /** 新会话标题（缺省由主进程生成「<源标题> · 分叉」） */
        title?: string;
        /** 缺省继承源会话 */
        model?: ModelRef;
        thinkingLevel?: string;
        planMode?: boolean;
        /** 以下字段由主进程从注册表补全，渲染层不传 */
        sourceSessionFile?: string;
        cwd?: string;
        mode?: SessionMode;
      };
    }
  | { id: string; type: "session.prompt"; payload: { sessionId: string; text: string; images?: ImageAttachment[] } }
  | {
      id: string;
      /** 导出会话上下文（handoff）：落盘 transcript.md + session.jsonl + handoff.md，返回接力提示词 */
      type: "session.exportContext";
      payload: {
        sessionId: string;
        /** 以下字段由主进程从注册表补全，渲染层不传 */
        sessionFile?: string;
        cwd?: string;
        title?: string;
      };
    }
  | { id: string; type: "session.setPlanMode"; payload: { sessionId: string; enabled: boolean } }
  | { id: string; type: "session.abort"; payload: { sessionId: string } }
  | {
      id: string;
      /** 手动压缩上下文（引擎会先 abort 当前运行；压缩过程走 compaction_start/end 事件） */
      type: "session.compact";
      payload: { sessionId: string };
    }
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
  /**
   * 沙盒运行状态查询（设置页可观测性）：返回内核边界是否真的生效、不可用的原因。
   * 会惰性触发 SandboxManager 初始化（首次约 1–2s），调用方需带超时。
   */
  | { id: string; type: "sandbox.status" }
  /** AI 生成主题：可选指定模型（默认取设置里的默认模型，缺省退回可用列表首个） */
  | { id: string; type: "theme.generate"; payload: { description: string; model?: ModelRef } }
  | { type: "memory.setDistillEnabled"; payload: { enabled: boolean } }
  /** 高级搜索配置下发（设置页变更后推送；宿主就绪时重推） */
  | { type: "search.setAdvancedConfig"; payload: { config: AdvancedSearchConfig | null } }
  /** 沙盒设置下发（设置页变更后推送；宿主就绪时重推）。对已创建会话不生效，新会话生效 */
  | { type: "sandbox.setConfig"; payload: { config: SandboxSettings } }
  /** MCP 服务器配置下发（设置页变更后推送；宿主就绪时重推）。对已创建会话不生效，新会话生效 */
  | { type: "mcp.setServers"; payload: { servers: Record<string, McpServerConfig> } }
  /**
   * 压缩设置下发（设置页变更后推送；宿主就绪时重推）。
   * 与沙盒不同：pi 引擎每次压缩判断都实时读 SettingsManager，活跃会话即时生效。
   */
  | { type: "compaction.setConfig"; payload: { config: CompactionSettings } }
  | { id: string; type: "auth.setApiKey"; payload: { provider: string; apiKey: string } }
  | { id: string; type: "auth.listProviders" }
  | { type: "permission.reply"; payload: { requestId: string; approved: boolean } }
  | { type: "question.reply"; payload: { requestId: string; answers: QuestionAnswers } }
  | { type: "shutdown" };

export type HostEvent =
  | { type: "ready" }
  | { type: "locale.changed"; locale: import("./i18n/types.js").Locale }
  | { type: "response"; id: string; success: boolean; data?: unknown; error?: string }
  | { type: "session.event"; sessionId: string; event: unknown }
  | {
      type: "session.history";
      sessionId: string;
      messages: unknown[];
      /** 恢复会话时的上下文环初始值（投影中最后一条有效 assistant usage；压缩点之前的已作废为 null） */
      lastUsage?: UsageRecord | null;
    }
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
  /** 提问已被结清（回答/超时/会话终结）：渲染层与主进程据此撤下提问卡（评审 R3-C11） */
  | { type: "question.resolved"; requestId: string }
  /** 会话注册表发生变化（如定时任务新建会话）：渲染进程应重新拉取列表 */
  | { type: "sessions.changed" }
  /** 定时任务触发：已为其创建会话并注入 prompt */
  | { type: "schedule.fired"; taskId: string; name: string; sessionId: string }
  /** fatal=true 表示宿主进程已退出（渲染层据此置 hostReady=false）；普通错误（如 prompt 失败）不影响就绪态 */
  | { type: "host.error"; message: string; fatal?: boolean };

// ---------------------------------------------------------------------------
// 会话上下文导出（handoff）
// ---------------------------------------------------------------------------

/** session.exportContext 的返回：导出目录与三件套路径 + 可直接复制到剪贴板的接力提示词 */
export interface ExportContextResult {
  /** 导出目录（~/.spcode/exports/<slug>-<ts>/） */
  dir: string;
  /** 人类可读对话记录（Markdown） */
  transcriptPath: string;
  /** pi 原始会话文件整份复制（含所有分支/compaction/usage） */
  jsonlPath: string;
  /** 接力提示词落盘路径（与 promptText 同内容，剪贴板失败时的兜底） */
  promptPath: string;
  /** 接力提示词全文（渲染层复制到剪贴板） */
  promptText: string;
  stats: { messages: number; chars: number };
}

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

/** 厂商配额查询结果（QuotaService → 渲染层配额页/Composer 圆环；评审 R3-C12 下沉） */
export interface QuotaLimit {
  /** 行标签：每日额度 / 每周额度 / 余额… */
  label: string;
  /** 已用百分比 0-100；null 表示无进度（如余额文本行） */
  usedPercent: number | null;
  /** 右侧主文本（如 "45%" / "¥32.50"） */
  text: string | null;
  /** 重置时间或补充说明（如 "21:21" / "10月22日"） */
  resetText: string | null;
}

export interface QuotaInfo {
  provider: string;
  label: string;
  configured: boolean;
  plan: string | null;
  limits: QuotaLimit[];
  updatedAt: number;
  error?: string;
}

/** 用量账本按日聚合行（usage-ledger summarize 的返回元素） */
export interface DailyUsage {
  date: string;
  total: UsageAggregate;
  byModel: Record<string, UsageAggregate>;
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
        ? i18n.t("common:schedule.onceAt", {
            time: new Intl.DateTimeFormat(getLocale(), {
              month: "numeric",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }).format(new Date(task.runAt)),
          })
        : i18n.t("common:schedule.once");
    case "hourly":
      return i18n.t("common:schedule.hourly", { minute: task.minute });
    case "daily":
      return i18n.t("common:schedule.daily", { time: hm });
    case "weekday":
      return i18n.t("common:schedule.weekday", { time: hm });
    case "weekly": {
      const weekday = task.weekday ?? 1;
      const weekdayNames = [
        "common:schedule.weekdays.0",
        "common:schedule.weekdays.1",
        "common:schedule.weekdays.2",
        "common:schedule.weekdays.3",
        "common:schedule.weekdays.4",
        "common:schedule.weekdays.5",
        "common:schedule.weekdays.6",
      ] as const;
      return i18n.t("common:schedule.weekly", { weekday: i18n.t(weekdayNames[weekday] ?? weekdayNames[1]), time: hm });
    }
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
  /** renderer -> main (invoke)：沙盒运行状态（是否真的启用内核边界/不可用原因） */
  sandboxStatus: "spcode:sandbox-status",
  /** renderer -> main (invoke)：字体与主题文件操作 */
  pickFontFile: "spcode:pick-font-file",
  getFontData: "spcode:get-font-data",
  pickThemeFile: "spcode:pick-theme-file",
  /** renderer -> main (invoke)：选择项目文件夹 / 图片附件 / 任意文件（MD 输入模式） */
  pickDirectory: "spcode:pick-directory",
  pickImages: "spcode:pick-images",
  pickFiles: "spcode:pick-files",
  /** renderer -> main (invoke)：输入框草稿全量读/写（渲染层防抖保存） */
  getComposerDrafts: "spcode:get-composer-drafts",
  setComposerDrafts: "spcode:set-composer-drafts",
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
  /** renderer -> main (invoke)：会话 git 改动查看/还原（评审 R3-F2） */
  sessionGitState: "spcode:session-git-state",
  sessionGitDiff: "spcode:session-git-diff",
  sessionGitRevert: "spcode:session-git-revert",
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
  /** main -> renderer：更新状态机变化推送（UpdateState） */
  updateState: "spcode:update-state",
  /** renderer -> main (invoke)：更新状态查询 / 手动下载 / 重启安装 / 忽略版本 */
  updateGetState: "spcode:update-get-state",
  updateDownload: "spcode:update-download",
  updateInstall: "spcode:update-install",
  updateIgnore: "spcode:update-ignore",
} as const;

// ---------------------------------------------------------------------------
// 自动更新（Finch 式：不自动下载，状态机推送渲染进程，用户主导下载与重启）
// ---------------------------------------------------------------------------

/**
 * 更新状态机（主进程持有，变化时推送渲染进程）：
 * idle → available（发现新版本，附发布说明）→ downloading（进度）→ downloaded（待重启）
 * 任何阶段出错进 error（渲染进程可据此前重试下载）；忽略版本/无更新回 idle。
 */
export type UpdateState =
  | { status: "idle" }
  | { status: "available"; version: string; releaseNotes: string }
  | { status: "downloading"; version: string; percent: number }
  | { status: "downloaded"; version: string }
  | { status: "error"; message: string };

/** electron-updater 的 releaseNotes 有三种形态（字符串/数组/空），统一归一为展示用纯文本 */
export function normalizeReleaseNotes(
  notes: string | { version?: string; note?: string | null }[] | null | undefined,
): string {
  if (!notes) return "";
  if (typeof notes === "string") return notes.trim();
  return notes
    .map((n) => n.note?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
}

/** MCP 服务器配置（评审 R3-F3，MVP：stdio 传输） */
export interface McpServerConfig {
  /** 可执行文件（如 npx / uvx / 绝对路径） */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 缺省启用；false = 停用但保留配置 */
  enabled?: boolean;
}

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

export type { Locale } from "./i18n/types.js";

import { getLocale, i18n } from "./i18n/index.js";

export interface AppSettings {
  locale: import("./i18n/types.js").Locale;
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
  /** 桌面通知：权限/提问/长任务完成且窗口未聚焦时发系统通知（评审 R3-F4） */
  desktopNotifications: boolean;
  /** 接收测试版更新；undefined = 跟随当前版本形态（beta 版收 beta，稳定版只收稳定） */
  betaUpdates?: boolean;
  /** 在更新弹窗里点了「忽略此版本」的版本号；该版本不再提示，更高版本仍会提示 */
  ignoredUpdateVersion?: string;
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
  /** 上下文压缩：阈值/保留窗口/开关（下发 pi 引擎，活跃会话实时生效） */
  compaction: CompactionSettings;
  /** MCP 服务器（stdio）：设置页维护，新会话生效；工具经权限网关裁决 */
  mcpServers: Record<string, McpServerConfig>;
  /**
   * 免审批规则（权限卡「总允许」沉淀，Finch 式）：命令前缀列表，仅匹配 bash/powershell。
   * 命中且 risk 为 write/outward 时免弹窗；danger 级永远不免。主进程裁决时读取。
   */
  permissionRules: string[];
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
  /**
   * 逃生舱（对齐 Claude Code allowUnsandboxedCommands，默认开）：命令与沙盒根本冲突
   * （GUI/Electron 应用、钥匙串、Mach 服务等）时，模型可用 dangerouslyDisableSandbox=true
   * 申请无沙盒重试——必经权限弹窗。关闭 = 严格模式，逃生舱参数直接被网关拒绝。
   */
  allowUnsandboxedCommands: boolean;
  /**
   * 沙盒外命令白名单（命令前缀匹配，如 "git push"、"pnpm test:e2e"）：命中的命令
   * 不经沙盒直接执行，走普通权限流（不享受 autoAllow 免审批）。「总允许」逃生舱请求时会自动写入。
   */
  excludedCommands: string[];
  network: {
    /** 放行的域名（支持 *.example.com 与 example.com:443 端口语法） */
    allowedDomains: string[];
    /** 显式拒绝的域名（优先于 allowedDomains） */
    deniedDomains: string[];
    /** 允许沙盒内命令监听本地端口（dev server、 vite/playwright 等需要），默认开 */
    allowLocalBinding: boolean;
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
  allowUnsandboxedCommands: true,
  excludedCommands: [],
  network: {
    allowedDomains: DEFAULT_SANDBOX_ALLOWED_DOMAINS,
    deniedDomains: [],
    allowLocalBinding: true,
  },
  filesystem: {
    extraAllowWrite: [],
    extraDenyRead: [],
    extraDenyWrite: [],
  },
};

/**
 * 沙盒运行状态快照（设置页展示用）。
 * state=active 才是「内核边界真的生效」；disabled = 用户关了总开关；
 * unavailable = 平台/依赖/初始化失败——reason 就是用户在 UI 上看到的解释。
 */
export interface SandboxStatusReport {
  state: "active" | "disabled" | "unavailable";
  reason?: string;
  /** 当前平台（darwin = Seatbelt；linux = bubblewrap；win32 = 暂不支持） */
  platform: string;
  /** 设置页当前开关快照（可能与 state 不一致，正好用来解释“为何没生效”） */
  enabled: boolean;
  autoAllow: boolean;
  allowUnsandboxedCommands: boolean;
}

export interface CustomTheme {
  name: string;
  /** 明暗基底。注意：代码块 shiki 高亮主题钉死在 MessageItem.tsx 的 SHIKI_THEME（当前 github-dark），
   *  支持浅色基底时需联动切换那里的高亮方案（评审 N3） */
  base: "dark" | "light";
  colors: Record<string, string>;
}

// ---------------------------------------------------------------------------
// 上下文压缩设置
// ---------------------------------------------------------------------------

/**
 * 上下文压缩设置（透传给 pi 引擎的 compaction 子系统）。
 * 触发语义：估算上下文用量 > 模型窗口 - reserveTokens 时自动压缩；
 * 压缩时从最新往前保留 keepRecentTokens 原文，更早的折叠成 LLM 摘要。
 */
export interface CompactionSettings {
  /** 自动压缩开关；关闭不影响手动压缩（输入框旁上下文环悬浮卡里发起） */
  enabled: boolean;
  /** 触发预留：剩余窗口不足此值时开始压缩（同时是模型输出的保底空间） */
  reserveTokens: number;
  /** 压缩时保留最近原文的 token 量（引擎默认 20000；出厂放宽到 40000 减少「上一轮改动被折叠」） */
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 40000,
};

/**
 * 压缩设置归一化：非法字段回落出厂默认。
 * 必须在上游拦住——pi 引擎读到非法 compaction 值会在 agent 循环里直接 throw。
 */
export function sanitizeCompactionSettings(input: unknown): CompactionSettings {
  const src = input && typeof input === "object" && !Array.isArray(input) ? (input as Partial<CompactionSettings>) : {};
  const num = (v: unknown, dflt: number): number =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : dflt;
  return {
    enabled: typeof src.enabled === "boolean" ? src.enabled : DEFAULT_COMPACTION_SETTINGS.enabled,
    reserveTokens: num(src.reserveTokens, DEFAULT_COMPACTION_SETTINGS.reserveTokens),
    keepRecentTokens: num(src.keepRecentTokens, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens),
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  locale: "zh-CN",
  defaultModel: null,
  defaultThinkingLevel: "medium",
  permissionMode: "ask",
  themeId: "spcode-dark",
  customTheme: null,
  uiFontFamily: "",
  monoFontFamily: "",
  autoUpdate: true,
  desktopNotifications: true,
  memoryDistill: true,
  quickQuota: true,
  disabledProviders: [],
  disabledModels: [],
  uiFontFile: "",
  monoFontFile: "",
  advancedSearch: null,
  sandbox: DEFAULT_SANDBOX_SETTINGS,
  compaction: DEFAULT_COMPACTION_SETTINGS,
  mcpServers: {},
  permissionRules: [],
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

/** 密钥字段回传渲染层时的掩码（写回同值 = 未修改，主进程还原真值；评审 R3-C8） */
export const SECRET_MASK = "••••••••";

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
