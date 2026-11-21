/** Final-argument gate shared by ordinary and nested Pi tool calls.
 * Execution-layer file/shell guards remain required. Trusted JS extensions are not an OS sandbox.
 */
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  decidePermissionMatrix,
  normalizeProjectCwd,
  type PermissionMode,
  type PermissionRequest,
  permissionScopes,
  type SandboxSettings,
} from "@spcode/shared";
import type { LocalizedText } from "@spcode/shared/i18n";
import { isPlanModeSafeCommand, PLAN_MODE_BASH_BLOCK_REASON, PLAN_MODE_WRITE_BLOCK_REASON } from "./plan-mode.js";
import { matchesExcludedCommand } from "./sandbox/bash-tool.js";
import { type FsGuardPolicy, judgeFsToolCall, resolveFsPath } from "./sandbox/fs-guard.js";
import type { SandboxState } from "./sandbox/manager.js";
import { applyModelRiskHint, classifyToolRisk, extractCommand, READONLY_TOOLS } from "./session-controller.js";

export interface BeforeToolCallCtx {
  toolCall: { id?: string; name: string; arguments?: unknown };
  /** Pi's prepared args, not toolCall.arguments. Mandatory on the managed extension path. */
  args?: unknown;
}
export type ToolCallVerdict = { block: true; reason: string; reasonMessage?: LocalizedText } | undefined;

export interface PermissionGateDeps {
  sessionId: string;
  principalId?: string;
  isPlanMode: () => boolean;
  getPermissionMode?: () => PermissionMode;
  getFsPolicy: () => FsGuardPolicy;
  getSandboxSettings?: () => SandboxSettings;
  getSandboxState: () => Promise<SandboxState>;
  requestPermission: (req: PermissionRequest) => Promise<boolean>;
  getPolicyRevision?: () => number;
  isCancelled?: () => boolean;
  /** Task ceiling/role checks: called both before approval and immediately before returning. */
  validateToolCall?: (name: string, args: unknown) => ToolCallVerdict;
  /** Hash of trusted server configuration (including credentials), never annotations. */
  getMcpServerIdentity?: (toolName: string) => string | undefined;
}

export function canonicalArgsDigest(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)) ?? "null")
    .digest("hex");
}

/** Resolve missing leaf paths through the nearest real ancestor (new-file grants). */
export function permissionRealpath(path: string): string {
  let parent = resolve(path);
  for (;;) {
    try {
      const real = realpathSync(parent);
      return normalizeProjectCwd(resolve(real, path.slice(parent.length).replace(/^[/\\]+/, "")));
    } catch {
      const next = dirname(parent);
      if (next === parent) throw new Error("Permission path cannot be resolved");
      parent = next;
    }
  }
}

const blocked = (reason: string): ToolCallVerdict => ({ block: true, reason });
const denied = (): ToolCallVerdict => ({
  block: true,
  reason: "User denied this tool call in Spcode permission dialog.",
  reasonMessage: { key: "main:permission.denied" },
});

export function createBeforeToolCallGate(deps: PermissionGateDeps) {
  return async (ctx: BeforeToolCallCtx): Promise<ToolCallVerdict> => {
    try {
      if (deps.isCancelled?.()) return blocked("Permission principal is cancelled.");
      const name = ctx.toolCall.name;
      const toolName = name.toLowerCase();
      const original = "args" in ctx ? ctx.args : ctx.toolCall.arguments;
      const args = structuredClone(original);
      const digest = canonicalArgsDigest(args);
      const revision = deps.getPolicyRevision?.() ?? 0;
      const fsPolicy = deps.getFsPolicy();
      const policyKey = () =>
        canonicalArgsDigest({
          mode: deps.getPermissionMode?.() ?? "ask",
          plan: deps.isPlanMode(),
          fs: deps.getFsPolicy(),
          sandbox: deps.getSandboxSettings?.(),
          mcp: deps.getMcpServerIdentity?.(name),
        });
      const policy = policyKey();
      const mode = deps.getPermissionMode?.() ?? "ask";
      const ceiling = deps.validateToolCall?.(name, args);
      if (ceiling) return ceiling;
      const fsVerdict = judgeFsToolCall(name, args, fsPolicy);
      if (fsVerdict?.action === "deny")
        return {
          block: true,
          reason: `Spcode path policy: ${fsVerdict.reason}`,
          reasonMessage: fsVerdict.reasonMessage,
        };
      const shell = toolName === "bash" || toolName === "powershell";
      const cmd = extractCommand(args);
      if (deps.isPlanMode()) {
        if (shell) {
          if (!cmd || !isPlanModeSafeCommand(cmd))
            return {
              block: true,
              reason: PLAN_MODE_BASH_BLOCK_REASON,
              reasonMessage: { key: "main:permission.planBash" },
            };
          // 计划态安全只读命令不再进入风险审批流
          return undefined;
        }
        if (!READONLY_TOOLS.has(toolName))
          return {
            block: true,
            reason: PLAN_MODE_WRITE_BLOCK_REASON,
            reasonMessage: { key: "main:permission.planWrite" },
          };
        // 只读但命中路径 prompt（如应用记忆区）：仍走 danger 审批，不因计划态豁免
        if (fsVerdict?.action !== "prompt") return undefined;
      }
      const settings = deps.getSandboxSettings?.();
      const state = shell ? await deps.getSandboxState() : undefined;
      const sandboxed = shell && settings?.enabled !== false && state?.state === "active";
      // Escape requests always require once approval, even when the OS sandbox is unavailable.
      const bypass =
        shell && (args as { dangerouslyDisableSandbox?: unknown } | null)?.dangerouslyDisableSandbox === true;
      const excluded =
        sandboxed && cmd !== null && (settings?.excludedCommands ?? []).some((r) => matchesExcludedCommand(cmd, r));
      const mcp = toolName.startsWith("mcp__");
      const localRisk = mcp ? "outward" : classifyToolRisk(name, args);
      const risk = fsVerdict?.action === "prompt" ? "danger" : shell ? applyModelRiskHint(localRisk, args) : localRisk;
      const cwd = permissionRealpath(resolve(fsPolicy.cwd));
      const selector = (): PermissionRequest["selector"] => {
        if (fsVerdict) {
          const raw = (args as { path?: unknown } | null)?.path;
          return {
            kind: "file",
            operation: toolName,
            realpath: permissionRealpath(resolveFsPath(fsPolicy.cwd, typeof raw === "string" ? raw : fsPolicy.cwd)),
          };
        }
        const serverIdentity = mcp ? deps.getMcpServerIdentity?.(name) : undefined;
        return serverIdentity ? { kind: "mcp", serverIdentity, toolName: name, argsDigest: digest } : undefined;
      };
      const binding = selector();
      const request: PermissionRequest = {
        requestId: randomUUID(),
        sessionId: deps.sessionId,
        principalId: deps.principalId ?? deps.sessionId,
        toolCallId: ctx.toolCall.id,
        argsDigest: digest,
        policyRevision: revision,
        toolName: name,
        args,
        risk,
        cwd,
        selector: binding,
        sandboxed: sandboxed && !excluded && !bypass,
        bypass: bypass || undefined,
        executionBoundary: !shell
          ? "in-process"
          : bypass
            ? "bypass"
            : excluded
              ? "excluded"
              : sandboxed
                ? "sandbox"
                : state?.state === "disabled"
                  ? "disabled"
                  : "unavailable",
      };
      request.allowedScopes = permissionScopes(request);
      const verdict = decidePermissionMatrix({
        risk,
        mode,
        bypass,
        bypassDisabled: !settings?.allowUnsandboxedCommands,
      });
      if (verdict.action === "block")
        return { block: true, reason: verdict.reason, reasonMessage: { key: verdict.reasonKey } };
      if (verdict.action === "ask" && !(await deps.requestPermission(request))) return denied();
      // No stale approval: revocation/cancellation/args/path/server changes require a fresh invocation.
      if (
        deps.isCancelled?.() ||
        revision !== (deps.getPolicyRevision?.() ?? 0) ||
        policy !== policyKey() ||
        digest !== canonicalArgsDigest(original) ||
        canonicalArgsDigest(binding) !== canonicalArgsDigest(selector())
      ) {
        return blocked("Permission binding changed or was revoked; retry with the current policy and arguments.");
      }
      const finalFs = judgeFsToolCall(name, args, deps.getFsPolicy());
      if (finalFs?.action === "deny") return blocked(`Spcode path policy: ${finalFs.reason}`);
      return deps.validateToolCall?.(name, args);
    } catch (error) {
      return blocked(`Permission check failed closed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
