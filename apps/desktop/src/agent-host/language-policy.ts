import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { getLocale } from "@spcode/shared/i18n";

/** Request-only section: never persist locale instructions in conversation history. */
export const LANGUAGE_POLICY_SECTION = "spcode-output-language";

/** Also usable by one-shot generation (for example titles and theme descriptions). */
export function buildLanguagePolicy(locale: "zh-CN" | "en" = getLocale()): string {
  const language = locale === "zh-CN" ? "Simplified Chinese (zh-CN)" : "English (en)";
  return `<output-language>
The current UI language is ${language}. Write all newly generated user-visible text, including ordinary responses, session titles, questions and question options, todo descriptions and active forms, plans, Task descriptions and conclusions, and theme names and descriptions, in this language. Do not infer the output language from the language of the user's input or earlier conversation. This rule supersedes older default-language conventions in memory or history.
Honor an explicit user request to use another language for the requested task or artifact. Do not change the language of internal thinking/reasoning. Preserve code, file paths, identifiers, literal quotations, user-provided content, and existing conversation history verbatim; do not translate them. Internal instructions and tool protocols remain in English.
</output-language>`;
}

type LanguagePolicyAgent = Pick<AgentSession["agent"], "transformContext">;

/**
 * pi calls transformContext before convertToLlm/normalizeContext on EVERY request,
 * including tool continuations and steering. Run the engine/extension hook first,
 * then snapshot the latest process locale. Only copy system envelopes; never append
 * a terminal system message (the last user/tool result must remain valid).
 */
export function installLanguagePolicy(agent: LanguagePolicyAgent): void {
  const previous = agent.transformContext;
  agent.transformContext = async (messages, signal) => {
    const transformed = previous ? await previous.call(agent, messages, signal) : messages;
    const rule = buildLanguagePolicy();
    const projected = transformed.map((message, index) => {
      if (message.role !== "system") return message;
      // Replace only our reserved section if a previous request projection was reused.
      if (index !== 0 && !(LANGUAGE_POLICY_SECTION in (message.sections ?? {}))) return message;
      return { ...message, sections: { ...message.sections, [LANGUAGE_POLICY_SECTION]: rule } };
    });
    if (projected[0]?.role !== "system") {
      projected.unshift({ role: "system", content: "", sections: { [LANGUAGE_POLICY_SECTION]: rule }, timestamp: 0 });
    }
    return projected;
  };
}
