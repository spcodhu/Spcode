/**
 * Microcompact —— 渐进式压缩的第一层（对标 Claude Code 的 micro-compact）。
 *
 * 在引擎的全量 LLM 摘要压缩触发之前做无损清扫：把「最近 K 个 assistant 回合之前」
 * 的旧工具结果用 context_edit 投影级替换成占位符。原文仍在会话文件里（append-only），
 * 只是不再进模型上下文；模型需要时会重新读文件/跑命令。
 *
 * 收益依据（真实会话统计）：工具结果占上下文 56.6%，其中 99%+ 是旧回合的；
 * 清扫后多数会话直接回到触发线以下，全量摘要（花钱、有损、质量方差）被推迟甚至避免。
 *
 * 挂载点：agent_settled 后（与记忆蒸馏同一时机）。引擎每轮压缩判断都读投影估算，
 * 而 context_edit 会让估算不再信任旧 usage（estimateProjectedContextTokens 的既有语义），
 * 所以清扫后引擎自然看到降低后的占用。
 */

import type { AgentSession, ProjectedSessionEntry, SettingsManager } from "@earendil-works/pi-coding-agent";

/** 触发比：投影估算超过 触发线(窗口 − reserveTokens) × 0.8 时清扫 */
const TRIGGER_RATIO = 0.8;
/** 保留最近 K 个 assistant 回合的工具结果不动（当前工作现场随时会被回看） */
const KEEP_RECENT_TURNS = 3;
/** 太小的工具结果不值得清扫（占位符本身也吃 token） */
const MIN_CHARS = 600;
/** 占位符前缀：已清理的内容二次扫描时据此跳过（双保险，editedIds 才是主判定） */
const PLACEHOLDER_PREFIX = "[该工具结果已被上下文清理折叠";

/** 占位符文案：明确告知模型内容去向与重获路径（导出供单测） */
export function placeholderText(chars: number): string {
  return `${PLACEHOLDER_PREFIX}（原约 ${(chars / 1000).toFixed(1)}k 字符）。原文仍在会话记录中；如需此内容，请重新执行相应操作获取。]`;
}

/** 消息的上下文体积估算（chars/4 口径之前的原始字符数；与 pi estimateTokens 的构成一致） */
function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content as Array<{ type?: string; text?: string; thinking?: string; arguments?: unknown }>) {
    if (b.type === "text" && b.text) n += b.text.length;
    else if (b.type === "thinking" && b.thinking) n += b.thinking.length;
    else if (b.type === "toolCall") n += JSON.stringify(b.arguments ?? {}).length;
    else if (b.type === "image") n += 4800;
  }
  return n;
}

export interface MicrocompactTarget {
  entryId: string;
  chars: number;
}

/**
 * 扫描投影，找出应被折叠的旧工具结果（纯函数，导出供单测）：
 * 从最新往旧数 KEEP_RECENT_TURNS 个含 assistant 消息的条目作为「当前工作现场」边界；
 * 边界之前的 toolResult 条目（未被编辑过、够大、不是占位符）即目标。
 */
export function findMicrocompactTargets(
  projectedEntries: ProjectedSessionEntry[],
  editedTargetIds: ReadonlySet<string>,
): MicrocompactTarget[] {
  // 定位边界：从后往前第 KEEP_RECENT_TURNS 个含 assistant 消息的条目
  let seen = 0;
  let boundary = -1;
  for (let i = projectedEntries.length - 1; i >= 0; i--) {
    const entry = projectedEntries[i];
    if (entry?.messages.some((m) => m.role === "assistant")) {
      seen++;
      if (seen >= KEEP_RECENT_TURNS) {
        boundary = i;
        break;
      }
    }
  }
  // 不足 K 个 assistant 回合：会话还短，没有可清扫的「旧」
  if (boundary < 0) return [];

  const targets: MicrocompactTarget[] = [];
  for (let i = 0; i < boundary; i++) {
    const entry = projectedEntries[i];
    if (!entry) continue;
    const src = entry.sourceEntry;
    if (src.type !== "message") continue;
    const msg = src.message;
    if (msg.role !== "toolResult") continue;
    if (editedTargetIds.has(src.id)) continue;
    // 用投影后的内容估算（若已被其它机制缩短，按缩短后的体积决定是否值得）
    const chars = entry.messages.reduce((sum, m) => sum + contentChars((m as { content?: unknown }).content), 0);
    if (chars < MIN_CHARS) continue;
    const firstText = entry.messages
      .flatMap((m) => {
        const c = (m as { content?: unknown }).content;
        return Array.isArray(c) ? c : [];
      })
      .find((b) => (b as { type?: string }).type === "text") as { text?: string } | undefined;
    if (firstText?.text?.startsWith(PLACEHOLDER_PREFIX)) continue;
    targets.push({ entryId: src.id, chars });
  }
  return targets;
}

/**
 * agent_settled 后的例行检查：接近自动压缩触发线时执行清扫。
 * 返回折叠条数（0 = 未触发/无目标/被开关禁用）。
 *
 * 挂在事件订阅链上，绝不向上抛异常——任何失败（条目缺失、分支竞争等）都静默跳过，
 * 最坏结果只是本次没清扫，引擎的全量压缩仍是兜底。
 */
export function maybeMicrocompact(session: AgentSession, settings: SettingsManager | undefined): number {
  try {
    const model = session.model;
    const contextWindow = model?.contextWindow ?? 0;
    if (contextWindow <= 0) return 0;
    const compaction = settings?.getCompactionSettings(model ?? undefined);
    // 跟随自动压缩开关：用户关掉自动压缩 = 不要任何自动上下文改写（手动压缩不受限）
    if (compaction && !compaction.enabled) return 0;
    const reserve = compaction?.reserveTokens ?? 16384;
    const threshold = contextWindow - reserve;
    if (threshold <= 0) return 0;

    const usage = session.getContextUsage();
    // tokens=null：压缩刚发生、尚无压缩后 usage，估算不可信，等下一轮
    if (!usage || usage.tokens === null) return 0;
    if (usage.tokens <= threshold * TRIGGER_RATIO) return 0;

    const projection = session.sessionManager.buildSessionProjection();
    const branch = session.sessionManager.getBranch();
    const editedIds = new Set(
      branch.filter((e) => e.type === "context_edit").map((e) => (e as { targetId: string }).targetId),
    );
    const targets = findMicrocompactTargets(projection.entries, editedIds);
    for (const t of targets) {
      session.sessionManager.appendContextEdit(t.entryId, {
        content: [{ type: "text", text: placeholderText(t.chars) }],
      });
    }
    if (targets.length > 0) {
      // 投影变了，重建 agent 上下文（下次请求即按清扫后的投影发送）
      session.refreshContext();
    }
    return targets.length;
  } catch {
    return 0;
  }
}
