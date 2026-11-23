import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, getCurrentTools } from "@earendil-works/pi-ai";
import { type AgentSession, convertToLlm, type SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ContextDetails, ContextMeasure, ContextPart } from "@spcode/shared/context";

type BudgetAgent = Pick<AgentSession["agent"], "transformContext">;
type Parts = ContextDetails["parts"];
const snapshots = new WeakMap<BudgetAgent, { revision: number; parts: Parts }>();
const unknown = (): ContextMeasure => ({ tokens: null, status: "unknown", source: "unknown" });
const estimate = (chars: number): ContextMeasure => ({
  tokens: Math.ceil(chars / 4),
  status: "estimated",
  source: "local-characters",
});

function contentChars(content: unknown): number | null {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return null;
  let chars = 0;
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") chars += block.text.length;
    else if (block.type === "thinking" && typeof block.thinking === "string") chars += block.thinking.length;
    else if (block.type === "toolCall") chars += JSON.stringify(block.arguments ?? {}).length + block.name.length;
    else return null; // Images / opaque blocks are provider-dependent, not zero-token text.
  }
  return chars;
}

function measure(messages: AgentMessage[], finalRequest: boolean): Parts {
  const totals: Record<ContextPart, number | null> = {
    systemHost: finalRequest ? 0 : null,
    rulesMemory: finalRequest ? 0 : null,
    toolSchema: finalRequest ? 0 : null,
    summaries: 0,
    recentMessages: 0,
    toolResults: 0,
    readEvidence: 0,
  };
  function add(part: ContextPart, chars: number | null) {
    if (totals[part] === null || chars === null) totals[part] = null;
    else totals[part] += chars;
  }
  if (finalRequest) {
    const llm = convertToLlm(messages);
    const system = getCurrentSystemMessage(llm);
    if (system) {
      add("systemHost", contentChars(system.content));
      // Effective structured sections, not every superseded prompt delta in the transcript.
      for (const [name, content] of Object.entries(system.sections ?? {})) {
        if (typeof content !== "string") continue;
        const part = /^(?:project_context|memory|rules|skills)$/.test(name) ? "rulesMemory" : "systemHost";
        if (name === "addendum" && /<memory[\s>]|# (?:Memory|记忆)/i.test(content)) {
          // Existing mixed addendum has no reliable per-source boundary; do not invent a split.
          totals.rulesMemory = null;
          totals.systemHost = null;
        } else add(part, content.length);
      }
    }
    add("toolSchema", JSON.stringify(getCurrentTools(llm)).length);
  }
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "compactionSummary" || message.role === "branchSummary") {
      add("summaries", message.summary.length);
    } else if (message.role === "toolResult") {
      add(message.toolName === "ReadEvidence" ? "readEvidence" : "toolResults", contentChars(message.content));
    } else if (message.role === "bashExecution") {
      if (!message.excludeFromContext) add("toolResults", message.output.length + message.command.length);
    } else if ("content" in message) {
      add("recentMessages", contentChars(message.content));
    } else add("recentMessages", null);
  }
  return Object.fromEntries(
    Object.entries(totals).map(([key, chars]) => [key, chars === null ? unknown() : estimate(chars)]),
  ) as Parts;
}

/** Install LAST, after Pi and host policy transforms. Stores counts only, never copies raw history. */
export function installContextBudgetObserver(agent: BudgetAgent): void {
  const previous = agent.transformContext;
  agent.transformContext = async (messages, signal) => {
    const transformed = previous ? await previous.call(agent, messages, signal) : messages;
    try {
      snapshots.set(agent, { revision: (snapshots.get(agent)?.revision ?? 0) + 1, parts: measure(transformed, true) });
    } catch {
      snapshots.delete(agent); // Telemetry must not interrupt a model request.
    }
    return transformed;
  };
}

export function estimateContextBreakdown(session: AgentSession, settings?: SettingsManager): ContextDetails {
  const manager = session.sessionManager;
  const snapshot = snapshots.get(session.agent);
  const projection = manager.buildSessionProjection();
  const parts = structuredClone(snapshot?.parts ?? measure(projection.messages, false));
  const branch = manager.getBranch();
  let providerInput = unknown();
  // After a compaction there is no trustworthy provider total until a new successful response.
  for (const entry of branch.toReversed()) {
    if (entry.type === "compaction") break;
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message;
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;
    const usage = message.usage;
    const tokens = usage.input + usage.cacheRead + usage.cacheWrite;
    if (Number.isFinite(tokens) && tokens > 0) providerInput = { tokens, status: "reported", source: "provider-usage" };
    break;
  }
  const compaction = (settings ?? session.settingsManager)?.getCompactionSettings(session.model);
  const outputReserve: ContextMeasure = compaction
    ? { tokens: compaction.reserveTokens, status: "configured", source: "compaction-settings" }
    : unknown();
  const fixed = [parts.systemHost.tokens, parts.rulesMemory.tokens, parts.toolSchema.tokens];
  const fixedTokens = fixed.every((tokens) => tokens !== null)
    ? fixed.reduce<number>((sum, n) => sum + (n ?? 0), 0)
    : null;
  const window = session.model?.contextWindow;
  return {
    revision: `${manager.getSessionId()}:${manager.getLeafId() ?? "root"}:${session.model?.provider ?? "?"}/${session.model?.id ?? "?"}:${snapshot?.revision ?? 0}:${outputReserve.tokens ?? "?"}`,
    basis: snapshot ? "last-request" : "session-projection",
    parts,
    providerInput,
    outputReserve,
    warning:
      fixedTokens !== null && window && outputReserve.tokens !== null && fixedTokens >= window - outputReserve.tokens
        ? "fixed-overhead"
        : null,
  };
}
