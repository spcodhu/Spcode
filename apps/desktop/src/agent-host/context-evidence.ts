import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { SessionEntry, SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type FsGuardPolicy, judgeFsPath, resolveFsPath } from "./sandbox/fs-guard.js";
import { createReadEvidenceTool, EVIDENCE_REF_PATTERN, pageEvidence } from "./tools/read-evidence.js";

export const EVIDENCE_ENTRY_TYPE = "spcode.context-evidence.v1";
export const EVIDENCE_PROVENANCE_TYPE = "spcode.context-provenance.v1";

type ToolEntry = Extract<SessionEntry, { type: "message" }> & {
  message: { role: "toolResult"; toolCallId: string; toolName: string; isError: boolean };
};
interface Provenance {
  version: 1;
  toolCallId: string;
  toolName: string;
  digest: string;
  paths: string[];
  unavailable?: string;
  sessionId: string;
  piSessionId: string;
  branchId: string | null;
}
export interface EvidenceRecord {
  version: 1;
  ref: string;
  sourceEntryId: string;
  sourceSessionId: string;
  sourcePiSessionId: string;
  sourceBranchId: string | null;
  toolCallId: string;
  toolName: string;
  timestamp: string;
  isError: boolean;
  digest: string;
  provenance: Provenance | null;
  /** Only child evidence is copied; root text stays in its original append-only message. */
  task?: { id: string; text: string };
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}
function isToolEntry(entry: SessionEntry | undefined): entry is ToolEntry {
  return entry?.type === "message" && entry.message.role === "toolResult";
}

/** State only, never a model message. Malformed/old schemas are not readable capabilities. */
export function evidenceRecord(entry: SessionEntry): EvidenceRecord | undefined {
  if (entry.type !== "custom" || entry.customType !== EVIDENCE_ENTRY_TYPE) return;
  const record = entry.data as EvidenceRecord | undefined;
  if (
    record?.version !== 1 ||
    typeof record.ref !== "string" ||
    !EVIDENCE_REF_PATTERN.test(record.ref) ||
    typeof record.sourceEntryId !== "string" ||
    typeof record.digest !== "string" ||
    typeof record.toolName !== "string" ||
    typeof record.timestamp !== "string"
  )
    return;
  return record;
}

/** Follow actual parent links, not array order: a sibling call/proof cannot establish provenance. */
function ancestors(entries: readonly SessionEntry[], entry: SessionEntry): SessionEntry[] {
  const byId = new Map(entries.map((item) => [item.id, item]));
  const result: SessionEntry[] = [];
  const seen = new Set<string>();
  let current: SessionEntry | undefined = entry;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    result.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return result.reverse();
}

function provenanceOf(entries: readonly SessionEntry[], entry: ToolEntry, text: string): Provenance | null {
  const path = ancestors(entries, entry);
  const hasCall = path.some(
    (item) =>
      item.type === "message" &&
      item.message.role === "assistant" &&
      item.message.content.some(
        (block) =>
          block.type === "toolCall" && block.id === entry.message.toolCallId && block.name === entry.message.toolName,
      ),
  );
  if (!hasCall) return null;
  for (const item of path.toReversed()) {
    if (item.type !== "custom" || item.customType !== EVIDENCE_PROVENANCE_TYPE) continue;
    const proof = item.data as Provenance | undefined;
    if (
      proof?.version === 1 &&
      proof.toolCallId === entry.message.toolCallId &&
      proof.toolName === entry.message.toolName &&
      proof.digest === digest(text)
    ) {
      return proof;
    }
  }
  return null;
}

/** Deliberately conservative, not a general or infallible secret detector. */
function suspicious(text: string): boolean {
  return /-----BEGIN (?:[A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----|\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|password)\s*[=:]\s*["']?[^\s"']{8,}|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/i.test(
    text,
  );
}
function sensitivePath(path: string): boolean {
  return /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|credentials(?:\.[^/\\]*)?|auth\.json|id_(?:rsa|ed25519)|[^/\\]+\.(?:pem|key|p12|pfx))(?:$|[/\\])/i.test(
    path,
  );
}

/** 来源证明是否足以支撑自动回读（不含随时间变化的当前文件策略/内容审查）。 */
function hasVerifiableProvenance(record: EvidenceRecord): boolean {
  const proof = record.provenance;
  return (
    !!proof &&
    proof.version === 1 &&
    !proof.unavailable &&
    Array.isArray(proof.paths) &&
    proof.paths.length > 0 &&
    proof.digest === record.digest
  );
}

export function createContextEvidence(options: {
  getSessionManager: () => SessionManager;
  getFsPolicy: () => FsGuardPolicy;
  sessionId: string;
}) {
  function records() {
    return options
      .getSessionManager()
      .getBranch()
      .flatMap((entry) => {
        const record = evidenceRecord(entry);
        return record ? [record] : [];
      });
  }
  function makeRecord(entry: ToolEntry, entries: readonly SessionEntry[], taskId?: string): EvidenceRecord {
    const manager = options.getSessionManager();
    const text = textOf(entry.message.content);
    const provenance = provenanceOf(entries, entry, text);
    return {
      version: 1,
      ref: `ev_${randomUUID().replaceAll("-", "")}`,
      sourceEntryId: entry.id,
      sourceSessionId: provenance?.sessionId ?? options.sessionId,
      sourcePiSessionId: provenance?.piSessionId ?? manager.getSessionId(),
      sourceBranchId: provenance?.branchId ?? entry.parentId,
      toolCallId: entry.message.toolCallId,
      toolName: entry.message.toolName,
      timestamp: entry.timestamp,
      isError: entry.message.isError,
      digest: digest(text),
      provenance,
      ...(taskId === undefined ? {} : { task: { id: taskId, text } }),
    };
  }
  function originalText(record: EvidenceRecord): string {
    if (record.task) return record.task.text;
    const branch = options.getSessionManager().getBranch();
    const entry = branch.find((item) => item.id === record.sourceEntryId);
    if (
      !isToolEntry(entry) ||
      entry.message.toolCallId !== record.toolCallId ||
      entry.message.toolName !== record.toolName
    ) {
      throw new Error("Evidence source is not reachable on the current branch.");
    }
    return textOf(entry.message.content);
  }
  function authorize(record: EvidenceRecord): string {
    const text = originalText(record);
    if (digest(text) !== record.digest) throw new Error("Evidence integrity check failed.");
    const proof = record.provenance;
    if (
      !proof ||
      proof.version !== 1 ||
      proof.digest !== record.digest ||
      proof.toolCallId !== record.toolCallId ||
      proof.toolName !== record.toolName
    ) {
      throw new Error(
        "Evidence unavailable: missing execution-time provenance. Historical tool arguments alone are not authorization.",
      );
    }
    if (proof.unavailable || !Array.isArray(proof.paths) || proof.paths.length === 0) {
      throw new Error(
        "Evidence unavailable: complete source paths could not be verified (shell, recursive search or unknown tool). Do not rerun the operation to recover this record.",
      );
    }
    const policy = options.getFsPolicy();
    for (const path of proof.paths) {
      if (typeof path !== "string" || sensitivePath(path) || judgeFsPath(policy, "read", path).action !== "allow") {
        throw new Error(
          "Evidence unavailable under the current file policy; fresh explicit authorization is required.",
        );
      }
    }
    if (suspicious(text))
      throw new Error("Evidence unavailable: potentially sensitive content requires explicit review.");
    return text;
  }

  return {
    /**
     * Wrap host-owned tools at construction time, inside the normal permission gate. Captures
     * final execution paths, not model-proposed args. Never grants permissions or changes output.
     * Only exact single-file tools have complete provenance today; shell/MCP/search stay closed.
     * Use a CHILD-local service for child wrappers, then publish its branch before disposal.
     */
    wrapTool(tool: ToolDefinition): ToolDefinition {
      return {
        ...tool,
        execute: async (id, args, signal, onUpdate, ctx) => {
          const manager = options.getSessionManager();
          const policy = options.getFsPolicy();
          const branchId = manager.getLeafId();
          let paths: string[] = [];
          let unavailable = "unverified-source";
          if (["read", "edit", "write"].includes(tool.name.toLowerCase())) {
            const raw = (args as { path?: unknown })?.path;
            if (typeof raw === "string") {
              try {
                const lexical = resolveFsPath(policy.cwd, raw);
                const canonical = realpathSync(lexical);
                paths = [...new Set([lexical, canonical])];
                if (paths.every((path) => !sensitivePath(path) && judgeFsPath(policy, "read", path).action === "allow"))
                  unavailable = "";
              } catch {
                unavailable = "missing-canonical-source";
              }
            }
          }
          const result = await tool.execute(id, args, signal, onUpdate, ctx);
          if (!unavailable) {
            try {
              if (realpathSync(paths[0]!) !== paths.at(-1)) unavailable = "source-changed-during-execution";
            } catch {
              unavailable = "source-changed-during-execution";
            }
          }
          // Never attach provenance to a different session if a getter changes during execution.
          if (manager === options.getSessionManager()) {
            manager.appendCustomEntry(EVIDENCE_PROVENANCE_TYPE, {
              version: 1,
              toolCallId: id,
              toolName: tool.name,
              digest: digest(textOf(result.content)),
              paths,
              ...(unavailable ? { unavailable } : {}),
              sessionId: options.sessionId,
              piSessionId: manager.getSessionId(),
              branchId,
            } satisfies Provenance);
          }
          return result;
        },
      };
    },
    /** 仅为有可验证执行时来源的条目登记引用；bash/grep/MCP 等无来源者返回 undefined，
     * 避免折叠占位符承诺一个必然失败的回读路径（R7 P1-1）。 */
    referenceEntry(entryId: string): string | undefined {
      const manager = options.getSessionManager();
      const branch = manager.getBranch();
      const entry = branch.find((item) => item.id === entryId);
      if (!isToolEntry(entry)) return undefined;
      const existing = records().find((record) => !record.task && record.sourceEntryId === entryId);
      if (existing) return hasVerifiableProvenance(existing) ? existing.ref : undefined;
      const record = makeRecord(entry, branch);
      if (!hasVerifiableProvenance(record)) return undefined;
      manager.appendCustomEntry(EVIDENCE_ENTRY_TYPE, record);
      return record.ref;
    },
    /** 已持久化的子任务交接证据：父会话可能仍需回看，折叠时显式保护（R7 P2-1）。 */
    protectedEntryIds(): Set<string> {
      return new Set(
        records()
          .filter((record) => record.task && hasVerifiableProvenance(record))
          .map((record) => record.sourceEntryId),
      );
    },
    /** Host callback only. Pass the child's active getBranch(), never a model-supplied transcript. */
    publishTask(taskId: string, entries: readonly SessionEntry[]): string[] {
      if (!taskId.trim()) throw new Error("A host task ID is required.");
      const refs: string[] = [];
      for (const entry of entries) {
        if (!isToolEntry(entry)) continue;
        const existing = records().find((record) => record.task?.id === taskId && record.sourceEntryId === entry.id);
        if (existing) {
          refs.push(existing.ref);
          continue;
        }
        const record = makeRecord(entry, entries, taskId);
        options.getSessionManager().appendCustomEntry(EVIDENCE_ENTRY_TYPE, record);
        refs.push(record.ref);
      }
      return refs;
    },
    /** A supplied array is a strict, snapshotted child allowlist (including []). */
    readTool(allowedRefs?: readonly string[]): ToolDefinition {
      const allowed = allowedRefs === undefined ? undefined : new Set(allowedRefs);
      return createReadEvidenceTool((ref, offset, limit) => {
        if (allowed && !allowed.has(ref)) throw new Error("Evidence ref was not explicitly delegated to this task.");
        const record = records().find((item) => item.ref === ref);
        if (!record) throw new Error("Evidence ref is not registered on the current authorized branch.");
        const text = authorize(record);
        return {
          ref,
          toolName: record.toolName,
          timestamp: record.timestamp,
          originalIsError: record.isError,
          ...pageEvidence(text, offset, limit),
        };
      });
    },
    /** Bounded, metadata-only catalog for the host policy. Does not expose paths or raw text. */
    catalog(limit = 24): Array<{ ref: string; toolName: string; available: boolean }> {
      return records()
        .slice(-Math.max(0, Math.min(64, limit)))
        .map((record) => {
          let available = true;
          try {
            authorize(record);
          } catch {
            available = false;
          }
          return { ref: record.ref, toolName: record.toolName, available };
        });
    },
  };
}
