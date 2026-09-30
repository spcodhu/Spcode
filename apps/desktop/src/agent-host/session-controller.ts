/**
 * SessionController —— 包装一个 pi AgentSession。
 *
 * 每个 Spcode 会话一个实例：负责 prompt/steer/abort/模型与思考档位切换，
 * 把 pi 事件原样上抛，并在 beforeToolCall 里接权限网关。
 * 自研工具（WebSearch/WebFetch/TodoWrite/AskUserQuestion/Task）在这里注册。
 * Token 用量在 message_end 事件里提取，单独走 usage 通道上抛。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type {
  ModelRef,
  PermissionRequest,
  QuestionRequest,
  SessionMode,
  TodoItem,
  ToolRisk,
  UsageRecord,
} from "@spcode/shared";
import { cleanSessionTitle } from "@spcode/shared";
import { MemoryDistiller } from "./distill.js";
import type { MemoryStore } from "./memory-store.js";
import {
  NORMAL_MODE_TOOLS,
  PLAN_MODE_BASH_BLOCK_REASON,
  PLAN_MODE_CUSTOM_TYPE,
  PLAN_MODE_OFF_MESSAGE,
  PLAN_MODE_ON_MESSAGE,
  PLAN_MODE_TOOLS,
  PLAN_MODE_WRITE_BLOCK_REASON,
  isPlanModeSafeCommand,
} from "./plan-mode.js";
import { createAskUserQuestionTool } from "./tools/ask-user.js";
import { createExitPlanModeTool } from "./tools/exit-plan-mode.js";
import { createRenameSessionTool } from "./tools/rename.js";
import { createTaskTool } from "./tools/task.js";
import { createTodoWriteTool } from "./tools/todowrite.js";
import { createWebFetchTool } from "./tools/webfetch.js";
import { createWebSearchTool } from "./tools/websearch.js";
import { createWritePlanTool } from "./tools/write-plan.js";

/** 工具风险分级：只读工具自动放行，写类/Shell 要确认（renamesession 无副作用，只读；writeplan/exitplanmode 只写应用自身目录/只改模式状态，只读） */
const READONLY_TOOLS = new Set(["read", "grep", "find", "ls", "websearch", "webfetch", "glob", "todowrite", "askuserquestion", "renamesession", "writeplan", "exitplanmode"]);
const DANGER_TOOL_NAMES = new Set(["bash", "powershell"]);

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
    return "write";
  }
  if (READONLY_TOOLS.has(name)) return "readonly";
  return "write";
}

function extractCommand(args: unknown): string | null {
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
  requestPermission: (req: PermissionRequest) => Promise<boolean>;
  askQuestion: (req: QuestionRequest) => Promise<Record<string, string>>;
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
    private readonly titleCtx: {
      onRename?: (title: string) => void;
      /** 模型调用 RenameSession 后由工具回调置位（共享探针，创建时序早于 controller） */
      renamedByAgent: { fired: boolean };
      /** false = 定时任务等场景，完全关闭标题自动化 */
      enabled: boolean;
      /** 恢复的会话不跑兜底（尊重已有标题） */
      isResumed: boolean;
    },
  ) {}

  static async create(opts: SessionControllerOptions): Promise<SessionController> {
    // 聊天模式不传 cwd 时用全局 scratch 目录
    const cwd = opts.cwd?.trim() ? opts.cwd : join(opts.agentDir, "..", "scratch");
    mkdirSync(cwd, { recursive: true });

    const model = opts.modelRef
      ? opts.modelRuntime.getModel(opts.modelRef.provider, opts.modelRef.modelId)
      : undefined;

    // 记忆注入：分层记忆块拼进系统提示尾部
    const isProject = opts.mode === "project";
    const memoryBlock = opts.memoryStore.buildInjection(isProject ? cwd : null, isProject);
    // 行为约定：引导模型在理解第一轮意图后用 RenameSession 起标题（agent 命名 + harness 兜底生成双保险）
    const titleBlock =
      "会话标题约定：如果当前会话还没有贴切的标题（默认是「新聊天」），在理解用户的第一轮意图后，调用一次 RenameSession 工具，用用户的语言起一个简短标题（不超过 30 字）。只调用一次，之后不要再改。";
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: opts.agentDir,
      appendSystemPrompt: [...(opts.noTitleAutomation ? [] : [titleBlock]), ...(memoryBlock ? [memoryBlock] : [])],
    });
    await resourceLoader.reload();

    // RenameSession 触发探针：模型主动改名后置位，兜底生成器据此让位
    const renameProbe = { fired: false };

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
      sessionManager: opts.sessionFile ? SessionManager.open(opts.sessionFile) : undefined,
      customTools: [
        createWebSearchTool(),
        createWebFetchTool(),
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
        }),
      ],
    });

    const ctl = new SessionController(
      opts.sessionId,
      session.sessionFile ?? null,
      session,
      opts.modelRuntime,
      opts.emitEvent,
      opts.emitPlanMode,
      {
        onRename: opts.onRename,
        renamedByAgent: renameProbe,
        enabled: !opts.noTitleAutomation,
        isResumed: !!opts.sessionFile,
      },
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
    });
    ctl.distiller = distiller;
    session.subscribe((event) => {
      if (event.type === "agent_start") ctl.running = true;
      if (event.type === "agent_settled") {
        ctl.running = false;
        distiller.schedule(session);
        ctl.maybeGenerateFallbackTitle();
      }
      opts.emitEvent(event);
      const usage = extractUsage(event, opts.sessionId, ctl.currentModelRef());
      if (usage) opts.emitUsage(usage);
    });

    // 权限网关：挂在 pi 的 beforeToolCall 钩子上
    session.agent.beforeToolCall = async (ctx) => {
      // 计划模式门禁(实时读取 planMode,运行中切换也立即生效):
      // bash 走只读白名单,放行且不再弹权限;写类调用本不该出现在计划工具集里,兜底拦截
      if (ctl.planMode) {
        const toolName = ctx.toolCall.name.toLowerCase();
        if (toolName === "bash" || toolName === "powershell") {
          const cmd = extractCommand(ctx.toolCall.arguments);
          if (cmd && isPlanModeSafeCommand(cmd)) return undefined;
          return { block: true, reason: PLAN_MODE_BASH_BLOCK_REASON };
        }
        if (!READONLY_TOOLS.has(toolName)) {
          return { block: true, reason: PLAN_MODE_WRITE_BLOCK_REASON };
        }
        return undefined;
      }
      const risk = classifyToolRisk(ctx.toolCall.name, ctx.toolCall.arguments);
      if (risk === "readonly") return undefined;
      const approved = await opts.requestPermission({
        requestId: randomUUID(),
        sessionId: opts.sessionId,
        toolName: ctx.toolCall.name,
        args: ctx.toolCall.arguments,
        risk,
      });
      if (approved) return undefined;
      return { block: true, reason: "User denied this tool call in Spcode permission dialog." };
    };

    return ctl;
  }

  info() {
    const model = this.session.model;
    return {
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      planMode: this.planMode,
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
      .then((title) => {
        // 小调用期间模型可能刚好主动改名了，主动命名优先
        if (title && !t.renamedByAgent.fired) t.onRename?.(title);
      })
      .catch(() => {});
  }

  async abort(): Promise<void> {
    await this.session.abort();
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
): Promise<string | null> {
  const prompt = [
    "给下面的用户请求起一个精炼的会话标题，用于侧边栏会话列表展示。",
    "要求：不超过 15 个字；与用户用语言一致；概括意图而不是照抄原文；",
    "只输出标题本身——不要引号、不要句号等结尾标点、不要任何解释。",
    "",
    "用户请求：",
    userText.slice(0, 600),
  ].join("\n");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await runtime.completeSimple(model as any, {
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  });
  const raw = result.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  // 清洗：压平空白 → 剥引号/结尾标点 → 截断兜底
  const title = cleanSessionTitle(raw)
    .replace(/^[\s"'「『《〈（(【\[]+|[\s"'」』》〉）)】\]。．.!！?？:：;；,，、…·~—-]+$/g, "")
    .slice(0, 20)
    .trim();
  return title || null;
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
