/**
 * SessionController —— 包装一个 pi AgentSession。
 *
 * 每个 Spcode 会话一个实例：负责 prompt/abort/模型与思考档位切换，
 * 把 pi 事件原样上抛，并在 beforeToolCall 里接权限网关。
 * Token 用量在 message_end 事件里提取，单独走 usage 通道上抛。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ModelRef, PermissionRequest, SessionMode, ToolRisk, UsageRecord } from "@spcode/shared";

/** 工具风险分级：只读工具自动放行，写类/Shell 要确认 */
const READONLY_TOOLS = new Set(["read", "grep", "find", "ls", "WebSearch", "websearch"]);
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
  if (READONLY_TOOLS.has(name) || name === "webfetch" || name === "glob") return "readonly";
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
  modelRef?: ModelRef;
  thinkingLevel?: string;
  emitEvent: (event: AgentSessionEvent) => void;
  emitUsage: (usage: UsageRecord) => void;
  requestPermission: (req: PermissionRequest) => Promise<boolean>;
}

export class SessionController {
  private constructor(
    readonly sessionId: string,
    private readonly session: AgentSession,
    private readonly runtime: ModelRuntime,
    private readonly emitEvent: (e: AgentSessionEvent) => void,
  ) {}

  static async create(opts: SessionControllerOptions): Promise<SessionController> {
    // 聊天模式不传 cwd 时用全局 scratch 目录
    const cwd = opts.cwd?.trim() ? opts.cwd : join(opts.agentDir, "..", "scratch");
    mkdirSync(cwd, { recursive: true });

    const model = opts.modelRef
      ? opts.modelRuntime.getModel(opts.modelRef.provider, opts.modelRef.modelId)
      : undefined;

    const { session } = await createAgentSession({
      cwd,
      agentDir: opts.agentDir,
      modelRuntime: opts.modelRuntime,
      model: model as Model<never> | undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      thinkingLevel: opts.thinkingLevel as any,
    });

    const ctl = new SessionController(opts.sessionId, session, opts.modelRuntime, opts.emitEvent);

    // 事件转发 + usage 提取
    session.subscribe((event) => {
      opts.emitEvent(event);
      const usage = extractUsage(event, opts.sessionId, ctl.currentModelRef());
      if (usage) opts.emitUsage(usage);
    });

    // 权限网关：挂在 pi 的 beforeToolCall 钩子上
    session.agent.beforeToolCall = async (ctx) => {
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
      model: model ? { provider: model.provider, modelId: model.id } : null,
      thinkingLevel: this.session.thinkingLevel,
      supportedThinkingLevels: model ? getSupportedThinkingLevels(model as Model<never>) : [],
    };
  }

  private currentModelRef(): ModelRef | null {
    const m = this.session.model;
    return m ? { provider: m.provider, modelId: m.id } : null;
  }

  async prompt(text: string): Promise<void> {
    await this.session.prompt(text);
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
    await this.session.dispose();
  }
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

function extractUsage(event: AgentSessionEvent, sessionId: string, model: ModelRef | null): UsageRecord | null {
  if (event.type !== "message_end" || !model) return null;
  const msg = event.message as { role?: string; usage?: UsageLike };
  if (msg.role !== "assistant" || !msg.usage) return null;
  const u = msg.usage;
  return {
    sessionId,
    model,
    timestamp: Date.now(),
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    costInput: u.cost.input,
    costOutput: u.cost.output,
    costCacheRead: u.cost.cacheRead,
    costCacheWrite: u.cost.cacheWrite,
    costTotal: u.cost.total,
  };
}

export type { SessionMode };
