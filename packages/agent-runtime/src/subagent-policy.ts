/**
 * 子代理偏好策略段（请求级注入，不落盘）：与 language-policy 同一投影模式。
 * 三档语义见 shared 的 SubagentMode；getter 逐请求快照，设置热更新无需重建会话。
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SUBAGENT_MODE, type SubagentMode } from "@spcode/shared";

/** Request-only section: never persist subagent preference instructions in conversation history. */
export const SUBAGENT_POLICY_SECTION = "spcode-subagent-policy";

export function buildSubagentPolicy(mode: SubagentMode): string {
  const body =
    mode === "off"
      ? "Task subagents are disabled by the user. The Task tool is unavailable; do all work directly in this session and never attempt to delegate."
      : mode === "direct"
        ? "Subagent delegation is in DIRECT MODE: the user selected direct implementation. Do all work yourself in this session with read/grep/find/ls/edit/write/bash. Calling Task is an exception reserved for two cases only: (1) a subtask requires reading roughly 20+ files so the main context would be flooded, or (2) the user explicitly asks for delegation. Before each Task call, state in one sentence why it meets this bar. Never delegate implementation, single-file changes, or small fixes. Every subagent run is a full model session and costs extra tokens. This instruction overrides any delegation guidance elsewhere, including the Task tool description."
        : "The user prefers delegating focused subtasks to Task subagents to keep the main context lean. Delegate read-heavy exploration, multi-file surveys and self-contained implementation chunks that can run independently; keep only their conclusions in the main context. Give each subagent complete, self-contained instructions.";
  return `<subagent-policy>\n${body}\n</subagent-policy>`;
}

type SubagentPolicyAgent = Pick<AgentSession["agent"], "transformContext">;

/**
 * pi calls transformContext before convertToLlm on EVERY request. Run the previous
 * hook first, then snapshot the latest mode. Only copy system envelopes; never append
 * a terminal system message (the last user/tool result must remain valid).
 */
export function installSubagentPolicy(
  agent: SubagentPolicyAgent,
  getMode: () => SubagentMode = () => DEFAULT_SUBAGENT_MODE,
): void {
  const previous = agent.transformContext;
  agent.transformContext = async (messages, signal) => {
    const transformed = previous ? await previous.call(agent, messages, signal) : messages;
    const rule = buildSubagentPolicy(getMode());
    const projected = transformed.map((message, index) => {
      if (message.role !== "system") return message;
      // Replace only our reserved section if a previous request projection was reused.
      if (index !== 0 && !(SUBAGENT_POLICY_SECTION in (message.sections ?? {}))) return message;
      return { ...message, sections: { ...message.sections, [SUBAGENT_POLICY_SECTION]: rule } };
    });
    if (projected[0]?.role !== "system") {
      projected.unshift({ role: "system", content: "", sections: { [SUBAGENT_POLICY_SECTION]: rule }, timestamp: 0 });
    }
    return projected;
  };
}
