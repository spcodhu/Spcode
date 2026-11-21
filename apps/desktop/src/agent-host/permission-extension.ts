import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { canonicalArgsDigest, createBeforeToolCallGate, type PermissionGateDeps } from "./permission-gate.js";
import { createSpcodeResourceLoader, type SpcodeResourceLoaderOptions } from "./pi-session-config.js";

const GATE_NAME = "spcode-permission-gate";
const GATE_PATH = `<inline:${GATE_NAME}>`;

function freezeDeep(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeDeep(child);
  Object.freeze(value);
}

/** Called only after all normal tool_call handlers have transformed prepared args.
 * Both public calls and ctx.executeTool use this event path in Pi 1.5.2.
 */
export function createPermissionExtension(deps: PermissionGateDeps): ExtensionFactory {
  const gate = createBeforeToolCallGate(deps);
  return (api) => {
    api.on("tool_call", async (event) => {
      try {
        const tool = api.getAllTools().find((candidate) => candidate.name === event.toolName);
        if (!tool) return { block: true, reason: "Permission gate: tool is no longer registered." };
        const schemaDigest = canonicalArgsDigest(tool.parameters);
        const validated = validateToolArguments(tool, {
          type: "toolCall",
          id: event.toolCallId,
          name: event.toolName,
          arguments: event.input as Parameters<typeof validateToolArguments>[1]["arguments"],
        });
        // Pi executes the original input object. Replace its properties with our independently
        // validated snapshot; freeze the root and descendants before awaiting human approval.
        // A frozen input is a previously validated snapshot: verify equality instead of rewriting.
        if (Object.isFrozen(event.input)) {
          if (canonicalArgsDigest(event.input) !== canonicalArgsDigest(validated)) {
            return { block: true, reason: "Permission gate: frozen arguments diverged from validation." };
          }
        } else {
          for (const key of Object.keys(event.input)) delete (event.input as Record<string, unknown>)[key];
          Object.assign(event.input, validated);
          freezeDeep(event.input);
        }
        const verdict = await gate({ toolCall: { id: event.toolCallId, name: event.toolName }, args: event.input });
        if (verdict) return verdict;
        const current = api.getAllTools().find((candidate) => candidate.name === event.toolName);
        if (!current || canonicalArgsDigest(current.parameters) !== schemaDigest) {
          return { block: true, reason: "Permission gate: tool schema changed during approval." };
        }
        return undefined;
      } catch (error) {
        return {
          block: true,
          reason: `Permission gate failed closed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  };
}

/** Non-replaceable, last on every reload, including with noExtensions/user overrides.
 * Do not replace agent.beforeToolCall: that would bypass extension veto and nested calls.
 */
export function createPermissionResourceLoader(options: SpcodeResourceLoaderOptions, deps: PermissionGateDeps) {
  return createSpcodeResourceLoader({
    ...options,
    extensionFactories: [
      ...(options.extensionFactories ?? []),
      { name: GATE_NAME, factory: createPermissionExtension(deps), replaceable: false, hidden: true },
    ],
    extensionsOverride: (loaded) => {
      const gate = loaded.extensions.find((extension) => extension.path === GATE_PATH);
      if (!gate) throw new Error("Mandatory permission extension failed to load");
      const overridden = options.extensionsOverride?.({ ...loaded, extensions: [...loaded.extensions] }) ?? loaded;
      return {
        ...overridden,
        extensions: [
          ...overridden.extensions.filter((extension) => extension !== gate && extension.path !== GATE_PATH),
          gate,
        ],
      };
    },
  });
}
