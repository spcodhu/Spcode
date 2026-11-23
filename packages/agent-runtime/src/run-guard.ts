/**
 * 每次任务运行的模型回合预算与连续相同工具调用保护。
 *
 * 检测语义参考 dsh repeat-tool-reminder：工具名 + 深度规范化参数精确匹配；
 * 第 3 次追加上下文提醒，第 5 次暂停。TodoWrite 等记账调用对链路透明，
 * 用户插话与主动继续重置检测。状态只在内存中按 SessionController 隔离。
 */
import type { AgentTurnContext, AgentTurnDecision } from "@earendil-works/pi-agent-core";
import {
  DEFAULT_MAX_MODEL_TURNS,
  REPEAT_TOOL_PAUSE_THRESHOLD,
  REPEAT_TOOL_REMINDER_THRESHOLD,
  type RunGuardCustomDetails,
  type RunGuardPause,
} from "@spcode/shared";

const TRANSPARENT_TOOLS = new Set(["todowrite"]);
const ARGUMENTS_PREVIEW_CHARS = 500;

interface RunGuardHooks {
  /** 在 turn_end 的合法边界追加模型可见、可持久化的上下文 */
  appendContext: (content: string, details: RunGuardCustomDetails) => Promise<void>;
  /** 暂停事件先于 agent_settled 下发，渲染层在 settled 时落错误卡 */
  emitPause: (pause: RunGuardPause) => void;
}

interface Chain {
  key: string;
  toolName: string;
  canonicalArguments: string;
  count: number;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** 工具参数由模型 JSON 提供；深度排序消除仅属性顺序不同的假差异。 */
export function canonicalizeToolArguments(value: unknown): string {
  return JSON.stringify(sortJsonValue(value)) ?? String(value);
}

function previewArguments(canonical: string): string {
  if (canonical.length <= ARGUMENTS_PREVIEW_CHARS) return canonical;
  return `${canonical.slice(0, ARGUMENTS_PREVIEW_CHARS)}… (+${canonical.length - ARGUMENTS_PREVIEW_CHARS} more chars)`;
}

export class RunGuard {
  private turns = 0;
  private chain: Chain | null = null;
  private pause: RunGuardPause | null = null;

  constructor(
    private readonly getMaxTurns: () => number = () => DEFAULT_MAX_MODEL_TURNS,
    private readonly hooks: RunGuardHooks,
  ) {}

  /** 新 prompt / 用户主动继续：开启一份新的回合预算与检测链。 */
  reset(): void {
    this.turns = 0;
    this.chain = null;
    this.pause = null;
  }

  /** 用户插话改变任务上下文，只重置重复链，不重置当前运行已用的回合预算。 */
  resetRepeatChain(): void {
    this.chain = null;
  }

  get lastPause(): RunGuardPause | null {
    return this.pause;
  }

  /**
   * 在一个完整模型回合及其工具结果结束后裁决。返回 end 只阻止下一次模型请求，
   * 不调用 abort，因此当前回合的消息、工具结果和错误卡在会话树里保持完整。
   */
  async finishTurn(turn: AgentTurnContext, willContinue: boolean): Promise<AgentTurnDecision | undefined> {
    if (this.pause) return { action: "end" };
    this.turns += 1;

    const calls = turn.message.content.filter((block) => block.type === "toolCall");
    for (const call of calls) {
      const pause = await this.observeCall(call.name, call.arguments);
      if (pause) return { action: "end" };
    }

    if (willContinue) {
      const limit = this.maxTurnsLimit();
      if (this.turns >= limit) {
        const pause: RunGuardPause = { reason: "maxTurns", turnCount: this.turns, limit };
        await this.pauseRun(
          pause,
          `The harness paused this run after reaching the configured model-turn limit (${limit}). ` +
            "If the user explicitly continues, inspect the completed work and avoid unnecessary turns.",
        );
        return { action: "end" };
      }
    }
    return undefined;
  }

  /** 设置热更新时也保证非法值不会静默关闭保护。 */
  private maxTurnsLimit(): number {
    const value = this.getMaxTurns();
    return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_MODEL_TURNS;
  }

  /** 返回非空暂停信息时调用方必须立即 end，不能再观察后续调用。 */
  private async observeCall(toolName: string, args: unknown): Promise<RunGuardPause | null> {
    if (TRANSPARENT_TOOLS.has(toolName.toLowerCase())) return null;
    const canonicalArguments = canonicalizeToolArguments(args);
    const key = JSON.stringify([toolName, canonicalArguments]);
    const count = this.chain?.key === key ? this.chain.count + 1 : 1;
    this.chain = { key, toolName, canonicalArguments, count };

    if (count === REPEAT_TOOL_REMINDER_THRESHOLD) {
      await this.hooks.appendContext(
        "You are repeating the exact same tool call with identical arguments. " +
          "Carefully analyze the previous result before calling again; change approach or arguments instead of repeating it.",
        { kind: "reminder", toolName, repeatCount: count },
      );
    }
    if (count !== REPEAT_TOOL_PAUSE_THRESHOLD) return null;

    const pause: RunGuardPause = {
      reason: "repeatTool",
      turnCount: this.turns,
      toolName,
      repeatCount: count,
      argumentsPreview: previewArguments(canonicalArguments),
    };
    await this.pauseRun(
      pause,
      `The harness paused this run after ${count} consecutive identical calls to ${toolName}. ` +
        "If the user explicitly continues, do not repeat that call with the same arguments. " +
        "Inspect the latest result, choose a different action, or explain the blockage.",
    );
    return pause;
  }

  private async pauseRun(pause: RunGuardPause, content: string): Promise<void> {
    this.pause = pause;
    await this.hooks.appendContext(content, { kind: "pause", pause });
    this.hooks.emitPause(pause);
  }
}
