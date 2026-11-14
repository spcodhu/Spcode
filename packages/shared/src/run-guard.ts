/** 每次任务运行的保护配置与可持久化暂停信息。 */

export const DEFAULT_MAX_MODEL_TURNS = 2000;
export const REPEAT_TOOL_REMINDER_THRESHOLD = 3;
export const REPEAT_TOOL_PAUSE_THRESHOLD = 5;
export const RUN_GUARD_CUSTOM_TYPE = "spcode.run-guard";

export type RunGuardReason = "maxTurns" | "repeatTool";

export interface RunGuardPause {
  reason: RunGuardReason;
  /** 暂停时已完成的模型回合数 */
  turnCount: number;
  /** reason=maxTurns 时的配置上限 */
  limit?: number;
  /** reason=repeatTool 时的重复工具与规范化参数预览 */
  toolName?: string;
  repeatCount?: number;
  argumentsPreview?: string;
}

export type RunGuardCustomDetails =
  | { kind: "reminder"; toolName: string; repeatCount: number }
  | { kind: "pause"; pause: RunGuardPause }
  | { kind: "continue"; pause: RunGuardPause };

/** 历史回放只接受结构完整的暂停详情，避免坏会话文件让渲染层崩溃。 */
export function parseRunGuardPause(value: unknown): RunGuardPause | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const src = value as Partial<RunGuardPause>;
  if (src.reason !== "maxTurns" && src.reason !== "repeatTool") return null;
  if (typeof src.turnCount !== "number" || !Number.isSafeInteger(src.turnCount) || src.turnCount < 1) return null;
  if (src.reason === "maxTurns") {
    return {
      reason: src.reason,
      turnCount: src.turnCount,
      ...(typeof src.limit === "number" ? { limit: src.limit } : {}),
    };
  }
  if (typeof src.toolName !== "string" || typeof src.repeatCount !== "number") return null;
  return {
    reason: src.reason,
    turnCount: src.turnCount,
    toolName: src.toolName,
    repeatCount: src.repeatCount,
    ...(typeof src.argumentsPreview === "string" ? { argumentsPreview: src.argumentsPreview } : {}),
  };
}

export function parseRunGuardCustomDetails(value: unknown): RunGuardCustomDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "pause" || kind === "continue") {
    const pause = parseRunGuardPause((value as { pause?: unknown }).pause);
    return pause ? { kind, pause } : null;
  }
  if (kind === "reminder") {
    const detail = value as { toolName?: unknown; repeatCount?: unknown };
    if (typeof detail.toolName === "string" && typeof detail.repeatCount === "number") {
      return { kind, toolName: detail.toolName, repeatCount: detail.repeatCount };
    }
  }
  return null;
}
