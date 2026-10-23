/**
 * SessionController —— 包装一个 pi AgentSession。
 *
 * 每个 Spcode 会话一个实例：负责 prompt/steer/abort/模型与思考档位切换，
 * 把 pi 事件原样上抛，并在 beforeToolCall 里接权限网关。
 * 自研工具（WebSearch/WebFetch/TodoWrite/AskUserQuestion/Task）在这里注册。
 * Token 用量在 message_end 事件里提取，单独走 usage 通道上抛。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AdvancedSearchConfig,
  ModelRef,
  PermissionRequest,
  QuestionAnswers,
  QuestionRequest,
  SandboxSettings,
  SessionInfo,
  SessionMode,
  TodoItem,
  ToolRisk,
  UsageRecord,
  WebFetchConfig,
} from "@spcode/shared";
import { isAdvancedSearchReady } from "@spcode/shared/advanced-search";
import { getLocale } from "@spcode/shared/i18n";
import { resolveSpcodeHome } from "@spcode/shared/node";
import { MemoryDistiller } from "./distill.js";
import { buildLanguagePolicy, installLanguagePolicy } from "./language-policy.js";
import type { MemoryStore } from "./memory-store.js";
import { maybeMicrocompact } from "./microcompact.js";
import { createBeforeToolCallGate } from "./permission-gate.js";
import {
  NORMAL_MODE_TOOLS,
  PLAN_MODE_CUSTOM_TYPE,
  PLAN_MODE_OFF_MESSAGE,
  PLAN_MODE_ON_MESSAGE,
  PLAN_MODE_TOOLS,
} from "./plan-mode.js";
import { createSandboxedBashTool } from "./sandbox/bash-tool.js";
import { createGuardedFsTools, type FsGuardPolicy } from "./sandbox/fs-guard.js";
import { getSandboxService } from "./sandbox/manager.js";
import { createAdvancedSearchTool } from "./tools/advanced-search.js";
import { createAskUserQuestionTool } from "./tools/ask-user.js";
import { createExitPlanModeTool } from "./tools/exit-plan-mode.js";
import { createRenameSessionTool } from "./tools/rename.js";
import { createTaskTool } from "./tools/task.js";
import { createTodoWriteTool } from "./tools/todowrite.js";
import { createWebFetchTool } from "./tools/webfetch.js";
import { createWebSearchTool } from "./tools/websearch.js";
import { createWritePlanTool } from "./tools/write-plan.js";

/** 工具风险分级：只读工具自动放行，写类/Shell 要确认（renamesession 无副作用，只读；writeplan/exitplanmode 只写应用自身目录/只改模式状态，只读） */
export const READONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "websearch",
  "webfetch",
  "advancedsearch",
  "glob",
  "todowrite",
  "askuserquestion",
  "renamesession",
  "writeplan",
  "exitplanmode",
]);
const DANGER_TOOL_NAMES = new Set(["bash", "powershell"]);

/**
 * 对外动作特征（命中即 outward）：把影响推出本机的操作。
 * 即使沙盒可用也永远弹窗——沙盒管得住文件和网络，管不住「推出去」的语义后果
 * （SOUL 约定：对外动作先问）。注意 git push --force 已被 danger 表捕获，
 * 这里兜普通 push；danger 判定优先于 outward。
 */
const OUTWARD_CMD_PATTERNS: RegExp[] = [
  /\bgit\s+push\b/i,
  // npm publish 已被 danger 表捕获（优先级更高），这里兜 pnpm/yarn/bun
  /\b(pnpm|yarn|bun)\s+publish\b/i,
  // 词首不能是 . 或 /：排除 ~/.ssh、./ssh-keygen 这类路径误伤
  /(?<![\w./])(ssh|scp|sftp|rsync)\s/i,
  /\bgh\s+(release\s+create|pr\s+create|pr\s+merge|issue\s+create|repo\s+create)\b/i,
  /\bcurl\b[^|]*\s(-X\s*(POST|PUT|DELETE|PATCH)|--data|-d\s)/i,
  /\b(npx\s+)?vercel\s+(deploy|--prod)|\bnetlify\s+deploy\b/i,
];

function isOutwardCommand(cmd: string): boolean {
  return OUTWARD_CMD_PATTERNS.some((p) => p.test(cmd));
}

/** Bash 命令危险特征（命中即 danger，act 模式下也要确认） */
const DANGEROUS_CMD_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\b/i, // rm -rf / rm -fr / rm -r / rm -f
  /\brmdir\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+push\b[^|]*--force\b/i,
  /\b(chmod|chown)\s+(-[a-z]*\s+)*-[a-z]*r/i, // chmod -R / chown -R
  /\bsudo\b/i,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/i, // curl … | sh
  /\bkill\s+-9\b/i,
  /\blaunchctl\b/i,
  /\bbrew\s+uninstall\b/i,
  /\bnpm\s+(uninstall|publish)\b/i,
  /\bdd\s+.*of=\/dev\//i,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
  // 解释器内联执行（评审 P0-3）：denylist 天然可绕，至少把 -e/-c 直执钉成 danger
  /\b(node|deno|bun|python3?|ruby|perl|php)\s+(-[\w.]*\s+)*-(e|eval|c)\b/i,
  // 进程/定时器级操作
  /\b(pkill|killall|crontab)\b/i,
  // 强删分支（-d 仅删已合并、可留 write；-D 强删归 danger）
  /\bgit\s+branch\s+-[a-z]*D/i,
  // 写/删敏感配置目录（评审 P0-3）：~/.spcode 被写 = 记忆投毒，~/.ssh 等同理
  /(?:\b(?:rm|mv|cp|dd|tee|chmod|chown|ln|truncate)\b|>>?|\s--?o(?:utput)?\s)[^|;&]*~?\/\.(?:spcode|ssh|aws|gnupg|config)\b/i,
];

function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_CMD_PATTERNS.some((p) => p.test(cmd));
}

export function classifyToolRisk(toolName: string, args: unknown): ToolRisk {
  const name = toolName.toLowerCase();
  if (DANGER_TOOL_NAMES.has(name)) {
    const cmd = extractCommand(args);
    if (cmd && isDangerousCommand(cmd)) return "danger";
    if (cmd && isOutwardCommand(cmd)) return "outward";
    return "write";
  }
  if (READONLY_TOOLS.has(name)) return "readonly";
  return "write";
}

export function extractCommand(args: unknown): string | null {
  if (args && typeof args === "object" && "command" in args) {
    const c = (args as { command?: unknown }).command;
    return typeof c === "string" ? c : null;
  }
  return null;
}

export interface SessionControllerOptions {
  sessionId: string;
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  memoryStore: MemoryStore;
  mode?: SessionMode;
  modelRef?: ModelRef;
  thinkingLevel?: string;
  /** 打开已存在的 pi 会话文件（会话恢复） */
  sessionFile?: string;
  /** 直接传入现成的 pi SessionManager（Fork 场景：forkFrom 复制出的新会话树） */
  sessionManager?: SessionManager;
  /** 恢复会话时带上计划模式状态（来自会话注册表），true 则创建后直接进入计划态 */
  planMode?: boolean;
  emitEvent: (event: AgentSessionEvent) => void;
  emitUsage: (usage: UsageRecord) => void;
  emitTodo: (todos: TodoItem[]) => void;
  /** 计划模式开关变化（主进程回填注册表、渲染进程更新 UI） */
  emitPlanMode: (enabled: boolean) => void;
  /** WritePlan 落盘了计划文件（主进程回填 planFile） */
  emitPlan: (path: string) => void;
  /** 模型通过 RenameSession 工具起的标题（空函数 = 忽略） */
  onRename?: (title: string) => void;
  /** 定时任务等场景：关闭标题自动化（不注入标题约定、不跑兜底生成），标题由调用方指定 */
  noTitleAutomation?: boolean;
  /** 记忆蒸馏总开关（主进程设置页下发，实时读取） */
  isDistillEnabled?: () => boolean;
  /** 高级搜索配置（主进程设置页下发，实时读取；配置完整才注册 AdvancedSearch 工具） */
  getAdvancedSearchConfig?: () => AdvancedSearchConfig | null;
  /** WebFetch 抓取后端配置（主进程设置页下发；工具逐次调用实时读取，活跃会话即时生效） */
  getWebFetchConfig?: () => WebFetchConfig | null;
  /** 沙盒设置（主进程设置页下发，实时读取；enabled 且平台可用时 bash 走 OS 级沙盒） */
  getSandboxSettings?: () => SandboxSettings;
  /** MCP 工具表快照（评审 R3-F3；会话创建时取，mcp__server__tool 经权限网关） */
  getMcpTools?: () => ToolDefinition[];
  /**
   * 共享 pi SettingsManager（压缩设置载体）：引擎每轮压缩判断实时读取，
   * 主进程下发新配置后活跃会话即时生效。缺省时 pi 自建（读 ~/.spcode/agent/settings.json）。
   */
  piSettings?: SettingsManager;
  requestPermission: (req: PermissionRequest) => Promise<boolean>;
  askQuestion: (req: QuestionRequest) => Promise<QuestionAnswers>;
}

export class SessionController {
  private running = false;
  private distiller: MemoryDistiller | null = null;
  /** 兜底标题只尝试一次（首轮 agent_settled 后） */
  private fallbackTitleTried = false;
  /** 首条用户消息原文（兜底标题的语料） */
  private firstUserText: string | null = null;
  /** 计划模式状态（beforeToolCall 门禁实时读取；持久化在主进程注册表） */
  private planMode = false;

  private constructor(
    readonly sessionId: string,
    readonly sessionFile: string | null,
    private readonly session: AgentSession,
    private readonly runtime: ModelRuntime,
    private readonly emitEvent: (e: AgentSessionEvent) => void,
    private readonly emitPlanMode: (enabled: boolean) => void,
    /** 会话创建时的沙盒状态（与 bash 工具注册同生命周期，中途不变） */
    private readonly sandboxInfo: { state: string; reason?: string },
    private readonly titleCtx: {
      onRename?: (title: string) => void;
      /** 模型调用 RenameSession 后由工具回调置位（共享探针，创建时序早于 controller） */
      renamedByAgent: { fired: boolean };
      /** false = 定时任务等场景，完全关闭标题自动化 */
      enabled: boolean;
      /** 恢复的会话不跑兜底（尊重已有标题） */
      isResumed: boolean;
    },
    private readonly emitUsageCb: (usage: UsageRecord) => void,
  ) {}

  static async create(opts: SessionControllerOptions): Promise<SessionController> {
    // 聊天模式不传 cwd 时用全局 scratch 目录
    const cwd = opts.cwd?.trim() ? opts.cwd : join(opts.agentDir, "..", "scratch");
    mkdirSync(cwd, { recursive: true });

    const model = opts.modelRef ? opts.modelRuntime.getModel(opts.modelRef.provider, opts.modelRef.modelId) : undefined;

    // 记忆注入：分层记忆块拼进系统提示尾部
    const isProject = opts.mode === "project";
    const memoryBlock = opts.memoryStore.buildInjection(isProject ? cwd : null, isProject);
    // 行为约定：引导模型在理解第一轮意图后用 RenameSession 起标题（agent 命名 + harness 兜底生成双保险）
    const titleBlock =
      "Session title convention: If the session has no descriptive title yet (only the default new-chat title), call RenameSession once after understanding the user's first request. Use the current UI language, not the input language, unless the user explicitly requests another language for the title. Keep it short (at most 30 Chinese characters or 60 English characters). Call only once; do not rename it afterwards.";
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: opts.agentDir,
      appendSystemPrompt: [...(opts.noTitleAutomation ? [] : [titleBlock]), ...(memoryBlock ? [memoryBlock] : [])],
    });
    await resourceLoader.reload();

    // RenameSession 触发探针：模型主动改名后置位，兜底生成器据此让位
    const renameProbe = { fired: false };

    // 沙盒：下发设置并惰性初始化；active 时注册同名 bash 覆盖内置（pi 注册表 customTools 同名覆盖语义）
    const sandbox = getSandboxService();
    if (opts.getSandboxSettings) sandbox.configure(opts.getSandboxSettings());
    const sandboxState = await sandbox.ensureReady();

    // 文件工具路径守卫（评审 R3-C3）：pi 内置 fs 工具不在 OS 沙盒内，这里是它们的边界。
    // 实时读设置（extraDenyRead/extraAllowWrite 热生效）；硬 deny 与沙盒 denyRead 同源。
    const getFsPolicy = (): FsGuardPolicy => {
      const sb = opts.getSandboxSettings?.();
      return {
        cwd,
        spcodeHome: resolveSpcodeHome(),
        extraDenyRead: sb?.filesystem.extraDenyRead ?? [],
        extraAllowWrite: sb?.filesystem.extraAllowWrite ?? [],
      };
    };

    // ExitPlanMode 的批准回调晚绑定：工具注册早于 controller 构造（同 renameProbe 模式）
    const exitPlanCtx: { isOn: () => boolean; onApproved: () => Promise<void> } = {
      isOn: () => false,
      onApproved: async () => {},
    };

    const { session } = await createAgentSession({
      cwd,
      agentDir: opts.agentDir,
      modelRuntime: opts.modelRuntime,
      model: model as Model<never> | undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      thinkingLevel: opts.thinkingLevel as any,
      resourceLoader,
      settingsManager: opts.piSettings,
      sessionManager: opts.sessionManager ?? (opts.sessionFile ? SessionManager.open(opts.sessionFile) : undefined),
      customTools: [
        // 沙盒化 bash：active 时同名覆盖内置 bash；不可用/关闭时不注册，pi 用内置实现
        ...(sandboxState.state === "active"
          ? [createSandboxedBashTool(cwd, { allowBypass: true, getSettings: opts.getSandboxSettings })]
          : []),
        // 路径守卫版 read/write/edit：同名覆盖内置（进程内 fs 不受 OS 沙盒约束，这里是边界）
        ...createGuardedFsTools(cwd, getFsPolicy),
        // MCP 工具（R3-F3）：配置下发后新会话生效；mcp__server__tool 经权限网关（默认 write 风险）
        ...(opts.getMcpTools?.() ?? []),
        createWebSearchTool(),
        // 高级搜索：仅当用户在设置页配置了完整可用的搜索 API 才注册，
        // 没配置时工具列表里根本没有它（模型无从误调）。配置变更对己创建会话不生效，新会话生效。
        ...(isAdvancedSearchReady(opts.getAdvancedSearchConfig?.())
          ? [createAdvancedSearchTool(() => opts.getAdvancedSearchConfig?.() ?? null)]
          : []),
        createWebFetchTool(() => opts.getWebFetchConfig?.() ?? null),
        createTodoWriteTool(opts.emitTodo),
        createAskUserQuestionTool(opts.sessionId, opts.askQuestion),
        createWritePlanTool({
          plansDir: join(opts.agentDir, "..", "plans"),
          sessionId: opts.sessionId,
          onSaved: opts.emitPlan,
        }),
        createExitPlanModeTool({
          sessionId: opts.sessionId,
          ask: opts.askQuestion,
          isPlanMode: () => exitPlanCtx.isOn(),
          onApproved: () => exitPlanCtx.onApproved(),
        }),
        createRenameSessionTool((title) => {
          renameProbe.fired = true;
          opts.onRename?.(title);
        }),
        createTaskTool({
          cwd,
          agentDir: opts.agentDir,
          modelRuntime: opts.modelRuntime,
          model: model as Model<never> | undefined,
          thinkingLevel: opts.thinkingLevel ?? "medium",
          depth: 0,
          getSandboxSettings: opts.getSandboxSettings,
          requestPermission: opts.requestPermission,
        }),
      ],
    });
    installLanguagePolicy(session.agent);

    const ctl = new SessionController(
      opts.sessionId,
      session.sessionFile ?? null,
      session,
      opts.modelRuntime,
      opts.emitEvent,
      opts.emitPlanMode,
      sandboxState.state === "unavailable"
        ? { state: sandboxState.state, reason: sandboxState.reason }
        : { state: sandboxState.state },
      {
        onRename: opts.onRename,
        renamedByAgent: renameProbe,
        enabled: !opts.noTitleAutomation,
        isResumed: !!opts.sessionFile,
      },
      opts.emitUsage,
    );

    // ExitPlanMode 晚绑定回调接到 controller 上
    exitPlanCtx.isOn = () => ctl.planMode;
    // 批准路径不注入"手动关闭"消息:ExitPlanMode 的工具结果已带执行约束,
    // 再写一条"用户手动关闭"会自相矛盾
    exitPlanCtx.onApproved = () => ctl.applyPlanMode(false, false);

    // 初始工具集:正常态摘掉 WritePlan/ExitPlanMode;带 planMode 恢复的会话直接进计划工具集,
    // 并重注一次计划态约定(上次注入的消息可能已被压缩/截断出上下文)
    const initialPlanMode = opts.planMode === true;
    ctl.planMode = initialPlanMode;
    session.setActiveToolsByName(initialPlanMode ? PLAN_MODE_TOOLS : NORMAL_MODE_TOOLS);
    if (initialPlanMode) {
      await session.sendCustomMessage({
        customType: PLAN_MODE_CUSTOM_TYPE,
        content: PLAN_MODE_ON_MESSAGE,
        display: false,
      });
    }

    // 事件转发 + usage 提取 + running 状态跟踪 + 蒸馏调度
    const distiller = new MemoryDistiller(opts.memoryStore, {
      cwd,
      isProject,
      agentDir: opts.agentDir,
      modelRuntime: opts.modelRuntime,
      isEnabled: opts.isDistillEnabled,
      emitUsage: (usage) => opts.emitUsage(usage), // 蒸馏消耗计账（R3-C15）
      sessionId: opts.sessionId,
    });
    ctl.distiller = distiller;
    session.subscribe((event) => {
      if (event.type === "agent_start") ctl.running = true;
      if (event.type === "agent_settled") {
        ctl.running = false;
        // 渐进式压缩第一层：接近触发线时先无损折叠旧工具结果，
        // 让引擎的全量 LLM 摘要压缩更晚（甚至不再）触发
        maybeMicrocompact(session, opts.piSettings);
        distiller.schedule(session);
        ctl.maybeGenerateFallbackTitle();
      }
      opts.emitEvent(event);
      const usage = extractUsage(event, opts.sessionId, ctl.currentModelRef());
      if (usage) opts.emitUsage(usage);
    });

    // 权限网关：挂在 pi 的 beforeToolCall 钩子上（实现已抽 permission-gate.ts，
    // 与 Task 子代理共享同一裁决链——评审 R3-C4）
    session.agent.beforeToolCall = createBeforeToolCallGate({
      sessionId: opts.sessionId,
      isPlanMode: () => ctl.planMode,
      getFsPolicy,
      getSandboxSettings: opts.getSandboxSettings,
      sandboxState,
      requestPermission: opts.requestPermission,
    });

    return ctl;
  }

  info(): SessionInfo {
    const model = this.session.model;
    return {
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      planMode: this.planMode,
      sandbox: this.sandboxInfo as SessionInfo["sandbox"],
      model: model ? { provider: model.provider, modelId: model.id } : null,
      thinkingLevel: this.session.thinkingLevel,
      supportedThinkingLevels: model ? getSupportedThinkingLevels(model as Model<never>) : [],
    };
  }

  /**
   * 开关计划模式：切换工具集 + 注入状态消息（模型可见、UI 不显示）+ 上抛事件。
   * 运行中切换也安全：工具集对下一个模型请求生效，beforeToolCall 门禁实时读取状态。
   */
  async setPlanMode(enabled: boolean): Promise<void> {
    await this.applyPlanMode(enabled, true);
  }

  /**
   * 计划态切换的实现。injectMessage=false 用于 ExitPlanMode 批准路径:
   * 工具结果本身已宣告"计划模式已关闭、工具已恢复",无需再注入消息。
   */
  private async applyPlanMode(enabled: boolean, injectMessage: boolean): Promise<void> {
    if (this.planMode === enabled) return;
    this.planMode = enabled;
    this.session.setActiveToolsByName(enabled ? PLAN_MODE_TOOLS : NORMAL_MODE_TOOLS);
    if (injectMessage) {
      await this.session.sendCustomMessage({
        customType: PLAN_MODE_CUSTOM_TYPE,
        content: enabled ? PLAN_MODE_ON_MESSAGE : PLAN_MODE_OFF_MESSAGE,
        display: false,
      });
    }
    this.emitPlanMode(enabled);
  }

  /** 恢复会话时给渲染进程回放历史消息 */
  history(): unknown[] {
    return [...this.session.messages];
  }

  /**
   * 恢复会话时初始化上下文环的用量快照：取投影中最后一条有效 assistant usage。
   * 若该 usage 来自最新压缩点之前则作废返回 null——它反映的是压缩前的大上下文，
   * 直接展示就是「环突然变大」的假象（与 pi getContextUsage 的失效保护同语义）。
   */
  lastUsageForRing(): UsageRecord | null {
    return lastAssistantUsageForRing(this.sessionId, this.session.messages, this.currentModelRef());
  }

  /** 是否正在运行（含引擎流式中）：宿主休眠/安全释放的前置检查 */
  isRunning(): boolean {
    return this.running || this.session.isStreaming;
  }

  private currentModelRef(): ModelRef | null {
    const m = this.session.model;
    return m ? { provider: m.provider, modelId: m.id } : null;
  }

  /** 正在运行时发送 = steering 插话；空闲时 = 正常 prompt；图片附件随消息传给引擎 */
  async prompt(text: string, images?: { name: string; mimeType: string; data: string }[]): Promise<void> {
    if (this.firstUserText === null && text.trim()) this.firstUserText = text.trim();
    const imageContents = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    if (this.running || this.session.isStreaming) {
      await this.session.steer(text, imageContents);
      return;
    }
    await this.session.prompt(text, imageContents?.length ? { images: imageContents } : undefined);
  }

  /**
   * 兜底标题：首轮跑完模型仍没调 RenameSession 时，harness 用当前会话模型
   * 做一次 completeSimple 小调用生成精炼标题，走与 AI 改名相同的 onRename 通道。
   * 只尝试一次；失败静默（侧栏保留首条消息截断的即时兜底）。
   */
  private maybeGenerateFallbackTitle(): void {
    const t = this.titleCtx;
    if (!t.enabled || t.isResumed || t.renamedByAgent.fired || this.fallbackTitleTried || !this.firstUserText) return;
    const model = this.session.model;
    if (!model) return;
    this.fallbackTitleTried = true;
    void generateFallbackTitle(this.runtime, model as Model<never>, this.firstUserText)
      .then((result) => {
        // 计账（评审 R3-C15）：兜底标题是一次真实模型调用，计入用量账本
        if (result?.usage) this.emitUsageRecord(result.usage);
        // 小调用期间模型可能刚好主动改名了，主动命名优先
        if (result?.title && !t.renamedByAgent.fired) t.onRename?.(result.title);
      })
      .catch(() => {});
  }

  /** 兜底标题等辅助调用的 usage 上抛（与会话用量同通道，归属本会话） */
  private emitUsageRecord(u: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  }): void {
    const model = this.currentModelRef();
    if (!model) return;
    this.emitUsageCb({
      sessionId: this.sessionId,
      model,
      timestamp: Date.now(),
      input: u.input ?? 0,
      output: u.output ?? 0,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
      costInput: u.cost?.input ?? 0,
      costOutput: u.cost?.output ?? 0,
      costCacheRead: u.cost?.cacheRead ?? 0,
      costCacheWrite: u.cost?.cacheWrite ?? 0,
      costTotal: u.cost?.total ?? 0,
    });
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  /**
   * 手动压缩上下文。引擎行为：先 abort 当前运行（不重试被中断的回合），
   * 然后生成摘要并写 compaction entry；过程与结果走 compaction_start/end 事件。
   * 摘要/保留窗口参数由共享 SettingsManager 的当前值决定（设置页实时可调）。
   */
  async compact(): Promise<{ tokensBefore: number; estimatedTokensAfter?: number }> {
    const result = await this.session.compact();
    return { tokensBefore: result.tokensBefore, estimatedTokensAfter: result.estimatedTokensAfter };
  }

  async setModel(ref: ModelRef): Promise<void> {
    const model = this.runtime.getModel(ref.provider, ref.modelId);
    if (!model) throw new Error(`Model not found: ${ref.provider}/${ref.modelId}`);
    await this.session.setModel(model as Model<never>);
  }

  setThinkingLevel(level: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.session.setThinkingLevel(level as any);
  }

  async dispose(): Promise<void> {
    this.distiller?.cancel();
    await this.session.dispose();
  }
}

// ---------------------------------------------------------------------------
// 兜底标题生成
// ---------------------------------------------------------------------------

/**
 * 用指定模型为首条用户消息生成精炼标题；空结果返回 null（异常上抛，调用方静默）。
 * 导出供单测。
 */
export async function generateFallbackTitle(
  runtime: ModelRuntime,
  model: Model<never>,
  userText: string,
): Promise<{
  title: string | null;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  };
}> {
  const locale = getLocale();
  const prompt = [
    "Create a concise session title for the following request, for display in the sidebar.",
    "Use the current UI language, not the input language, unless the user explicitly requests another title language.",
    "Aim for at most 15 Chinese characters or 8 English words (60 characters). Summarize the intent, rather than copying the request.",
    "Output only the title: no quotation marks, trailing punctuation, or explanation.",
    "",
    "User request:",
    userText.slice(0, 600),
  ].join("\n");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await runtime.completeSimple(model as any, {
    systemPrompt: buildLanguagePolicy(locale),
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  });
  const raw = result.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  // 清洗：压平空白 → 剥引号/结尾标点 → 截断兜底
  const title = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s"'「『《〈（(【[]+|[\s"'」』》〉）)】\]。．.!！?？:：;；,，、…·~—-]+$/g, "")
    .slice(0, locale === "en" ? 60 : 20)
    .trim();
  return { title: title || null, usage: result.usage };
}

// ---------------------------------------------------------------------------
// usage 提取
// ---------------------------------------------------------------------------

interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/** 从 message_end 事件提取用量记录（导出供单测） */
export function extractUsage(event: AgentSessionEvent, sessionId: string, model: ModelRef | null): UsageRecord | null {
  if (event.type !== "message_end" || !model) return null;
  const msg = event.message as { role?: string; usage?: unknown; timestamp?: number };
  if (msg.role !== "assistant" || !msg.usage || typeof msg.usage !== "object") return null;
  // 对引擎结构零信任（评审 P1-3）：缺字段按 0 兜底，绝不在事件订阅链上抛异常
  const u = msg.usage as Partial<UsageLike>;
  const cost = (u.cost ?? {}) as Partial<UsageLike["cost"]>;
  return {
    sessionId,
    model,
    // 用消息产生时刻而非事件处理时刻，跨轮统计不漂移
    timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    costInput: cost.input ?? 0,
    costOutput: cost.output ?? 0,
    costCacheRead: cost.cacheRead ?? 0,
    costCacheWrite: cost.cacheWrite ?? 0,
    costTotal: cost.total ?? 0,
  };
}

export type { SessionMode };

// ---------------------------------------------------------------------------
// 恢复会话时的上下文环初始化
// ---------------------------------------------------------------------------

interface AssistantUsageLike {
  role?: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  timestamp?: number;
  usage?: Partial<UsageLike>;
}

/**
 * 从消息列表提取「上下文环初始值」：最后一条有效 assistant usage。
 * 规则（导出供单测）：
 * - 跳过 aborted/error 与全零 usage（它们不反映真实上下文体积）；
 * - 若最近一条有效 usage 的时间戳不晚于最新 compactionSummary，返回 null
 * （压缩点之前的 usage 反映的是压缩前的大上下文，直接展示就是假象）；
 * - 消息缺 provider/model 时回落当前会话模型。
 */
export function lastAssistantUsageForRing(
  sessionId: string,
  messages: unknown[],
  fallbackModel: ModelRef | null,
): UsageRecord | null {
  let lastCompactionTs = -Infinity;
  for (const raw of messages) {
    const m = raw as { role?: string; timestamp?: number };
    if (m.role === "compactionSummary" && typeof m.timestamp === "number") {
      if (m.timestamp > lastCompactionTs) lastCompactionTs = m.timestamp;
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as AssistantUsageLike;
    if (m.role !== "assistant" || !m.usage || typeof m.usage !== "object") continue;
    if (m.stopReason === "aborted" || m.stopReason === "error") continue;
    const u = m.usage;
    const input = u.input ?? 0;
    const output = u.output ?? 0;
    const cacheRead = u.cacheRead ?? 0;
    const cacheWrite = u.cacheWrite ?? 0;
    if (input + output + cacheRead + cacheWrite <= 0) continue;
    const ts = typeof m.timestamp === "number" ? m.timestamp : Date.now();
    if (ts <= lastCompactionTs) return null;
    const model = m.provider && m.model ? { provider: m.provider, modelId: m.model } : fallbackModel;
    if (!model) return null;
    const cost = (u.cost ?? {}) as Partial<UsageLike["cost"]>;
    return {
      sessionId,
      model,
      timestamp: ts,
      input,
      output,
      cacheRead,
      cacheWrite,
      costInput: cost.input ?? 0,
      costOutput: cost.output ?? 0,
      costCacheRead: cost.cacheRead ?? 0,
      costCacheWrite: cost.cacheWrite ?? 0,
      costTotal: cost.total ?? 0,
    };
  }
  return null;
}
