import type { AgentRequestUpdate, AgentTurnDecision, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  type ModelRuntime,
  type SessionEntry,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SUBAGENT_MODE,
  type PermissionMode,
  type PermissionRequest,
  type SandboxSettings,
  type SubagentMode,
} from "@spcode/shared";
import { i18n } from "@spcode/shared/i18n";
import { resolveSpcodeHome } from "@spcode/shared/node";
import {
  DEFAULT_TASK_LIMITS,
  TASK_SUMMARY_MAX_TOKENS,
  type TaskActivity,
  type TaskActivityStatus,
  type TaskArtifact,
  type TaskInput,
  type TaskLimits,
  type TaskResult,
  type TaskRole,
  type TaskToolEvidence,
} from "@spcode/shared/task-runtime";
import { Type } from "typebox";
import { installLanguagePolicy } from "../language-policy.js";
import { createPermissionResourceLoader } from "../permission-extension.js";
import type { ToolCallVerdict } from "../permission-gate.js";
import { createSpcodeSettingsManager } from "../pi-session-config.js";
import { RunGuard } from "../run-guard.js";
import { createSandboxedBashTool } from "../sandbox/bash-tool.js";
import { createGuardedFsTools, type FsGuardPolicy } from "../sandbox/fs-guard.js";
import { getSandboxService } from "../sandbox/manager.js";
import { createManagedPowerShellTool } from "../sandbox/powershell-tool.js";
import { installSubagentPolicy } from "../subagent-policy.js";
import {
  intersectTaskPermissionMode,
  type TaskRun,
  TaskRuntime,
  type TaskTree,
  type TaskUsageRecord,
  taskRoleAllowsTool,
} from "../task-runtime.js";
import { createSessionToolEnvironment, type SessionToolEnvironment } from "../tool-environment.js";
import {
  abortError,
  resolveWorkspaceWriterKey,
  type WorkspaceWriterLease,
  type WorkspaceWriterManager,
  workspaceWriterManager,
} from "../workspace-writer.js";
import { STRICT_PREFER_TOOL_SAMPLING } from "./tool-schema.js";

const MAX_HANDOFF_CHARS = 8000;
const MAX_TOOL_EVIDENCE = 64;

/** Callable tools as well as schemas are restricted; Task is a control-only exception. */
export function taskSessionToolNames(
  depth: number,
  mode: SubagentMode = DEFAULT_SUBAGENT_MODE,
  role: TaskRole = "readonly",
): string[] {
  return [
    "read",
    "grep",
    "find",
    "ls",
    "ReadEvidence",
    ...(role === "write" ? ["bash", "powershell", "edit", "write"] : []),
    ...(depth + 1 < DEFAULT_TASK_LIMITS.maxDepth && mode !== "off" ? ["Task"] : []),
  ];
}

export const taskSchema = Type.Object({
  description: Type.String({
    description: "Short task title in the current UI language",
    minLength: 1,
    maxLength: 200,
  }),
  prompt: Type.String({
    description: "Complete self-contained instructions; no parent conversation is copied",
    minLength: 1,
    maxLength: 24000,
  }),
  goal: Type.Optional(Type.String({ maxLength: 4000 })),
  background: Type.Optional(Type.String({ maxLength: 8000 })),
  scope: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 32 })),
  acceptance: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 32 })),
  evidenceRefs: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 64 })),
  role: Type.Optional(Type.Union([Type.Literal("readonly"), Type.Literal("write")], { default: "readonly" })),
  budget: Type.Optional(
    Type.Object({
      maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_TASK_LIMITS.childTurns })),
      wallTimeMs: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_TASK_LIMITS.childWallTimeMs })),
    }),
  ),
});

export interface TaskToolContext {
  cwd: string;
  agentDir: string;
  sessionId: string;
  modelRuntime: ModelRuntime;
  model: Model<never> | undefined;
  getModel?: () => Model<never> | undefined;
  thinkingLevel: string;
  depth: number;
  getSandboxSettings?: () => SandboxSettings;
  getPermissionMode?: () => PermissionMode;
  getSubagentMode?: () => SubagentMode;
  requestPermission: (req: PermissionRequest) => Promise<boolean>;
  toolEnvironment?: SessionToolEnvironment;
  /** Root controller starts this tree once per user prompt, not once per Tool call. */
  getTaskTree?: () => TaskTree;
  getTaskLimits?: () => Partial<TaskLimits>;
  /** Raw stream deltas only; do not account TaskResult.usage a second time. */
  emitUsage?: (usage: TaskUsageRecord) => void;
  /** 子任务活动快照（queued/running/终态 + 轮次/用量/最近工具）；嵌套 Task 经 ctx 展开继承。 */
  emitTask?: (activity: TaskActivity) => void;
  parentRun?: TaskRun;
  /** Host-trusted workspace root; never supplied by the model. */
  authorizedRoot?: string;
  writerManager?: WorkspaceWriterManager;
  /** Root permission restriction (e.g. plan mode), reevaluated before execution. */
  validateToolCall?: (name: string, args: unknown) => ToolCallVerdict;
  getPolicyRevision?: () => number;
  /** Clear the principal's real bridge pending requests, including late replies. */
  cancelPendingPermissions?: (principalId: string) => void;
  createEvidenceTool?: (refs: readonly string[]) => ToolDefinition;
  /** Persist into the parent's durable evidence store BEFORE child session disposal. */
  publishEvidence?: (taskId: string, entries: readonly SessionEntry[]) => string[];
}

function stoppedResult(id: string, description: string, reason: string, cancelled = false): TaskResult {
  return {
    schemaVersion: 1,
    taskId: id,
    description,
    status: cancelled ? "cancelled" : "blocked",
    summary: "",
    evidenceRefs: [],
    artifacts: [],
    acceptance: [],
    toolEvidence: [],
    unresolved: [reason],
    usage: {
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costTotal: 0,
      requests: 0,
      auxiliaryRequests: 0,
    },
  };
}

function toolResult(result: TaskResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    details: {
      ...result,
      presentation: {
        key: "agent:tool.taskResult",
        params: { description: result.description, result: result.summary || result.unresolved.join("\n") },
      },
    },
  };
}

/** Race cancellation without abandoning a late-created session or leaking listeners. */
async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onLate?: (value: T) => Promise<void>,
): Promise<T> {
  if (signal.aborted) {
    void promise.then((value) => onLate?.(value)).catch(() => {});
    throw abortError();
  }
  return new Promise<T>((resolve, reject) => {
    let cancelled = false;
    const abort = () => {
      cancelled = true;
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise
      .then(
        async (value) => {
          signal.removeEventListener("abort", abort);
          if (cancelled) await onLate?.(value);
          else resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          if (!cancelled) reject(error);
        },
      )
      .catch(() => {});
  });
}

/** 聊天行实时状态里的紧凑 token 计数（12.3k / 1.2M）。 */
function compactTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1000) return `${(total / 1000).toFixed(1)}k`;
  return String(total);
}

function promptForTask(args: TaskInput, run: TaskRun): string {
  return `${args.prompt}\n\n<task-contract>\n${JSON.stringify({
    goal: args.goal ?? args.prompt,
    background: args.background ?? "",
    scope: args.scope ?? [],
    acceptance: args.acceptance ?? [],
    evidenceRefs: args.evidenceRefs ?? [],
    role: run.role,
    maxTurns: run.maxTurns,
    deadline: new Date(run.deadline).toISOString(),
  })}\nReport work performed, observed evidence and unresolved items. Do not claim tests passed without tool evidence.\n</task-contract>`;
}

export function createTaskTool(ctx: TaskToolContext): ToolDefinition {
  // Compatibility fallback shares siblings; production MUST supply the root's prompt-scoped tree.
  const fallback = new TaskRuntime({ getTaskLimits: ctx.getTaskLimits, emitUsage: ctx.emitUsage });
  return {
    name: "Task",
    label: "Task (subagent)",
    description:
      "Delegate a self-contained task. Defaults to strictly readonly file/evidence retrieval (no shell/MCP). Request write explicitly; writes hold a workspace-wide FIFO lease. Provide goal, background, scope, acceptance and delegated evidenceRefs. Returns host status and bounded, unverified model summary plus durable evidence references.",
    promptSnippet: "Delegate focused self-contained subtasks; readonly parallel, workspace writes serial",
    parameters: taskSchema,
    constrainedSampling: STRICT_PREFER_TOOL_SAMPLING,
    executionMode: "parallel",
    execute: async (id, args: TaskInput, signal, onUpdate) => {
      if (signal?.aborted)
        return toolResult(stoppedResult(id, args.description, "Task cancelled before initialization", true));
      const tree = ctx.getTaskTree?.() ?? fallback.currentTree;
      const parent = ctx.parentRun ?? tree.root;
      let run: TaskRun;
      try {
        if (ctx.depth >= tree.limits.maxDepth || ctx.getSubagentMode?.() === "off")
          throw new Error("Task delegation is disabled or at depth limit");
        run = tree.createChild(parent, args.role ?? "readonly", args.budget, signal);
      } catch (error) {
        return toolResult(stoppedResult(id, args.description, String(error), signal?.aborted || parent.signal.aborted));
      }
      // 子任务活动事件：同一 execute 内按 taskId 覆盖式下发（queued → running → 终态）；
      // 进度只在回合/工具边界发射，无 token 级噪音；聊天行同步收到实时状态文本。
      const startedAt = Date.now();
      let lastToolName: string | undefined;
      const emitActivity = (status: TaskActivityStatus, extra?: Partial<TaskActivity>): void => {
        if (!ctx.emitTask) return;
        ctx.emitTask({
          schemaVersion: 1,
          taskId: run.id,
          parentTaskId: ctx.parentRun?.id ?? null,
          sourceToolCallId: id,
          description: args.description,
          role: run.role,
          // 委派层级 0 起算（0 = 根会话直接派生）；与 TaskToolContext.depth 同口径，区别于 TaskRun.depth（含根）
          depth: ctx.depth,
          status,
          startedAt,
          updatedAt: Date.now(),
          turns: run.usage.turns,
          maxTurns: run.maxTurns,
          usage: {
            input: run.usage.input,
            output: run.usage.output,
            cacheRead: run.usage.cacheRead,
            cacheWrite: run.usage.cacheWrite,
            costTotal: run.usage.costTotal,
          },
          ...(lastToolName ? { lastTool: lastToolName } : {}),
          ...extra,
        });
      };
      const emitProgressLine = (): void => {
        if (!onUpdate) return;
        const total = run.usage.input + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite;
        onUpdate({
          content: [
            {
              type: "text" as const,
              text: i18n.t("agent:tool.taskProgress", {
                description: args.description,
                turns: run.usage.turns,
                maxTurns: run.maxTurns,
                tokens: compactTokens(total),
                tool: lastToolName ?? "—",
              }),
            },
          ],
          details: {},
        });
      };
      emitActivity("queued");
      emitProgressLine();
      // Capture BEFORE waiting for a slot/lock. Parent relaxation never expands this cap.
      const permissionCap = ctx.getPermissionMode?.() ?? "ask";
      const getMode = () => intersectTaskPermissionMode(permissionCap, ctx.getPermissionMode?.() ?? "ask");
      const initialSandbox = ctx.getSandboxSettings ? structuredClone(ctx.getSandboxSettings()) : undefined;
      const manager = ctx.writerManager ?? workspaceWriterManager;
      const artifacts: TaskArtifact[] = [];
      const evidence: TaskToolEvidence[] = [];
      const unresolved: string[] = [];
      const actualCalls = new Set<string>();
      const pendingUsage: Promise<void>[] = [];
      let lease: WorkspaceWriterLease | undefined;
      let session: AgentSession | undefined;
      let unsubscribe: (() => void) | undefined;
      let result: TaskResult | undefined;
      let error: unknown;
      let sequence = 0;
      let streamKind: TaskUsageRecord["taskSource"] = "compaction";
      let lastStop: string | undefined;
      let summary = "";
      const cancelPermissions = () => ctx.cancelPendingPermissions?.(run.id);
      const abort = () => {
        cancelPermissions();
        void session?.abort().catch(() => {});
      };
      run.signal.addEventListener("abort", abort, { once: true });
      const getFsPolicy = (): FsGuardPolicy => {
        const sb = ctx.getSandboxSettings?.();
        return {
          cwd: ctx.cwd,
          spcodeHome: resolveSpcodeHome(),
          extraDenyRead: [
            ...new Set([...(initialSandbox?.filesystem.extraDenyRead ?? []), ...(sb?.filesystem.extraDenyRead ?? [])]),
          ],
          extraAllowWrite: (initialSandbox?.filesystem.extraAllowWrite ?? []).filter((path) =>
            sb?.filesystem.extraAllowWrite.includes(path),
          ),
        };
      };
      const validate = (name: string, params: unknown): ToolCallVerdict => {
        if (run.signal.aborted || Date.now() >= run.deadline)
          return { block: true, reason: "Task cancelled or timed out" };
        if (run.summaryStarted) return { block: true, reason: "Task final turn is summary-only; no tools may execute" };
        if (!taskRoleAllowsTool(run.role, name, params))
          return { block: true, reason: "Tool exceeds the Task role capability ceiling" };
        if ((params as { dangerouslyDisableSandbox?: unknown } | null)?.dangerouslyDisableSandbox)
          return { block: true, reason: "Task sandbox escape is forbidden" };
        // Shell's OS policy is process-owned. If it was relaxed since creation, do not
        // borrow the broader global policy; fail closed rather than silently expand.
        if (initialSandbox && ["bash", "powershell"].includes(name.toLowerCase())) {
          const live = ctx.getSandboxSettings?.();
          if (
            live &&
            ((initialSandbox.enabled && !live.enabled) ||
              live.excludedCommands.some((rule) => !initialSandbox.excludedCommands.includes(rule)) ||
              initialSandbox.filesystem.extraDenyRead.some((path) => !live.filesystem.extraDenyRead.includes(path)) ||
              live.filesystem.extraAllowWrite.some((path) => !initialSandbox.filesystem.extraAllowWrite.includes(path)))
          ) {
            return {
              block: true,
              reason: "Sandbox was relaxed after Task creation; delegate a new Task to use the new policy",
            };
          }
        }
        return ctx.validateToolCall?.(name, params);
      };
      try {
        await parent.whileWaitingForChild(async () => {
          run.assertLive();
          const key = await resolveWorkspaceWriterKey(ctx.cwd, ctx.authorizedRoot ?? ctx.cwd, run.signal);
          if (run.role === "write") lease = await manager.acquire(key, run.owner, run.signal);
          // Writer wait never owns an execution slot.
          await run.acquireActiveSlot();
          run.assertLive();
          emitActivity("running");
          emitProgressLine();
          const sandbox = getSandboxService();
          if (ctx.getSandboxSettings) sandbox.configure(ctx.getSandboxSettings());
          if (run.role === "write") await abortable(sandbox.ensureReady(), run.signal);
          const environment = ctx.toolEnvironment ?? createSessionToolEnvironment();
          const allowed = taskSessionToolNames(ctx.depth, ctx.getSubagentMode?.(), run.role);
          const tools: ToolDefinition[] = createGuardedFsTools(ctx.cwd, getFsPolicy, environment.path).filter((tool) =>
            allowed.includes(tool.name),
          );
          if (ctx.createEvidenceTool) tools.push(ctx.createEvidenceTool(args.evidenceRefs ?? []));
          if (run.role === "write") {
            tools.push(
              createSandboxedBashTool(ctx.cwd, {
                allowBypass: false,
                sessionId: run.id,
                environment,
                getSettings: ctx.getSandboxSettings,
              }),
            );
            if (process.platform === "win32") tools.push(createManagedPowerShellTool(ctx.cwd, { environment }));
          }
          if (run.depth < tree.limits.maxDepth && ctx.getSubagentMode?.() !== "off") {
            tools.push(
              createTaskTool({
                ...ctx,
                depth: ctx.depth + 1,
                parentRun: run,
                getTaskTree: () => tree,
                getPermissionMode: getMode,
                validateToolCall: validate,
                toolEnvironment: environment,
              }),
            );
          }
          const wrapped = tools.map(
            (tool): ToolDefinition => ({
              ...tool,
              // Within one child, never release its slot while another local tool is running.
              // Sibling Task invocations from the root remain parallel.
              executionMode: "sequential",
              execute: async (callId, params, toolSignal, update, toolContext) => {
                const verdict = validate(tool.name, params);
                if (verdict) return { content: [{ type: "text", text: verdict.reason }], details: {}, isError: true };
                run.assertLive();
                const invoke = async () => {
                  actualCalls.add(callId);
                  const output = await tool.execute(callId, params, toolSignal, update, toolContext);
                  if (!output.isError && ["write", "edit"].includes(tool.name)) {
                    const path = (params as { path?: unknown }).path;
                    if (typeof path === "string")
                      artifacts.push({ toolCallId: callId, path, operation: tool.name as "write" | "edit" });
                  }
                  return output;
                };
                return ["write", "edit", "bash", "powershell"].includes(tool.name)
                  ? manager.withLease(key, run.owner, run.signal, invoke)
                  : invoke();
              },
            }),
          );
          const settingsManager = createSpcodeSettingsManager();
          const resourceLoader = createPermissionResourceLoader(
            { cwd: ctx.cwd, agentDir: ctx.agentDir, settingsManager },
            {
              sessionId: ctx.sessionId,
              principalId: run.id,
              isPlanMode: () => false,
              getPermissionMode: getMode,
              getFsPolicy,
              getSandboxSettings: ctx.getSandboxSettings,
              getSandboxState: () => sandbox.ensureReady(),
              getPolicyRevision: ctx.getPolicyRevision,
              isCancelled: () => run.signal.aborted,
              validateToolCall: validate,
              requestPermission: (request) => abortable(ctx.requestPermission(request), run.signal),
            },
          );
          await abortable(resourceLoader.reload(), run.signal);
          run.assertLive();
          const created = await abortable(
            createAgentSession({
              cwd: ctx.cwd,
              agentDir: ctx.agentDir,
              modelRuntime: ctx.modelRuntime,
              model: ctx.getModel?.() ?? ctx.model,
              thinkingLevel: ctx.thinkingLevel as ThinkingLevel,
              sessionManager: SessionManager.inMemory(ctx.cwd),
              settingsManager,
              resourceLoader,
              tools: wrapped.map((tool) => tool.name),
              customTools: wrapped,
              excludeTools: process.platform === "win32" ? [] : ["powershell"],
            }),
            run.signal,
            async ({ session: late }) => {
              await late.dispose();
            },
          );
          session = created.session;
          run.assertLive();
          session.agent.toolExecution = "sequential";
          installLanguagePolicy(session.agent);
          installSubagentPolicy(session.agent, () => ctx.getSubagentMode?.() ?? DEFAULT_SUBAGENT_MODE);
          const child = session;
          unsubscribe = child.subscribe((event) => {
            if (event.type === "tool_execution_start") {
              lastToolName = event.toolName;
              emitActivity("running");
              emitProgressLine();
            }
            if (event.type === "tool_execution_end")
              evidence.push({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                isError: event.isError,
                evidenceRefs: [],
              });
            if (event.type === "message_end" && event.message.role === "assistant") {
              lastStop = event.message.stopReason;
              if (event.message.stopReason === "error")
                unresolved.push(event.message.errorMessage ?? "Provider request failed");
            }
          });
          const guard = new RunGuard(() => Number.MAX_SAFE_INTEGER, {
            appendContext: async (content) => {
              child.sessionManager.appendCustomMessageEntry("task-run-guard", content, false);
            },
            emitPause: () => {
              run.stopReason = "repeatTool";
            },
          });
          const previousPrepare = child.agent.prepareRequest;
          child.agent.prepareRequest = async (request, requestSignal): Promise<AgentRequestUpdate | undefined> => {
            run.assertLive();
            await run.acquireActiveSlot();
            const prepared = await previousPrepare?.(request, requestSignal);
            run.assertLive();
            const ticket = run.reserveTurn();
            if (ticket === "stop") throw new Error("Task work budget exhausted");
            streamKind = ticket;
            if (ticket !== "summary") return prepared ?? undefined;
            child.setActiveToolsByName([]);
            return {
              ...prepared,
              thinkingLevel: "off",
              context: { ...(prepared?.context ?? request.context), tools: [] },
            };
          };
          const previousTransform = child.agent.transformContext;
          child.agent.transformContext = async (messages, requestSignal) => {
            const projected = previousTransform ? await previousTransform(messages, requestSignal) : messages;
            const contract = `${promptForTask(args, run)}\n${run.summaryStarted ? `The host reserved the FINAL turn for a summary only (max ${TASK_SUMMARY_MAX_TOKENS} output tokens). No tools. Return partial work, evidence and unresolved items.` : run.lineage.some((ancestor) => ancestor.warningIssued) ? "Budget warning: at least 80% consumed. Prioritize handoff." : ""}`;
            return projected.map((message, index) =>
              message.role === "system"
                ? {
                    ...message,
                    ...(run.summaryStarted ? { toolsAdded: [], toolsRemoved: [] } : {}),
                    ...(index === 0 ? { sections: { ...message.sections, "spcode-task-contract": contract } } : {}),
                  }
                : message,
            );
          };
          const previousFinish = child.agent.finishTurn;
          child.agent.finishTurn = async (turn, turnSignal): Promise<AgentTurnDecision | undefined> => {
            const previous = await previousFinish?.(turn, turnSignal);
            if (run.summaryStarted || run.signal.aborted || ["error", "aborted"].includes(turn.message.stopReason))
              return { action: "end" };
            await guard.finishTurn(turn, false);
            if (run.stopReason === "repeatTool" && run.remainingTurns > 0) return { action: "continue" };
            if (run.remainingTurns <= 0) {
              run.stopReason = "budget";
              return { action: "end" };
            }
            return previous ?? undefined;
          };
          const previousStream = child.agent.streamFunction;
          child.agent.streamFunction = async (model, transcript, options) => {
            run.assertLive();
            const source = streamKind;
            streamKind = "compaction";
            const usageId = `${run.id}:${++sequence}`;
            const stream = await previousStream(model, transcript, {
              ...options,
              signal: options?.signal ? AbortSignal.any([options.signal, run.signal]) : run.signal,
              ...(source === "summary" ? { maxTokens: TASK_SUMMARY_MAX_TOKENS, reasoning: "minimal" as const } : {}),
            });
            pendingUsage.push(
              stream.result().then((message) => {
                const u = message.usage;
                const finite = (value: number | undefined) =>
                  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
                tree.recordUsage(run, {
                  sessionId: ctx.sessionId,
                  taskId: run.id,
                  usageId,
                  taskSource: source,
                  model: { provider: message.provider ?? model.provider, modelId: message.model ?? model.id },
                  timestamp: message.timestamp,
                  input: finite(u?.input),
                  output: finite(u?.output),
                  cacheRead: finite(u?.cacheRead),
                  cacheWrite: finite(u?.cacheWrite),
                  costInput: finite(u?.cost?.input),
                  costOutput: finite(u?.cost?.output),
                  costCacheRead: finite(u?.cost?.cacheRead),
                  costCacheWrite: finite(u?.cost?.cacheWrite),
                  costTotal: finite(u?.cost?.total),
                  source: source === "compaction" ? "compaction" : "conversation",
                });
                emitActivity("running");
                emitProgressLine();
              }),
            );
            return stream;
          };
          await child.prompt(promptForTask(args, run));
          summary = child.getLastAssistantText() ?? "";
        });
      } catch (caught) {
        error = caught;
        if (!run.signal.aborted && !run.stopReason)
          unresolved.push(caught instanceof Error ? caught.message : String(caught));
      } finally {
        try {
          await Promise.allSettled(pendingUsage);
          if (session) summary = session.getLastAssistantText() ?? summary;
          let refs: string[] = [];
          if (session) {
            try {
              refs = ctx.publishEvidence?.(run.id, session.sessionManager.getBranch()) ?? [];
              if (!ctx.publishEvidence && evidence.length)
                unresolved.push("Evidence persistence is not connected; no durable evidence references were produced");
            } catch (persistError) {
              unresolved.push(`Evidence persistence failed: ${String(persistError)}`);
            }
          }
          if (run.stopReason) unresolved.unshift(`Host stop reason: ${run.stopReason}`);
          if (artifacts.length > MAX_TOOL_EVIDENCE || evidence.length > MAX_TOOL_EVIDENCE)
            unresolved.push("Handoff lists are truncated; consult persisted evidence");
          const successful = evidence.some((item) => !item.isError && actualCalls.has(item.toolCallId));
          const blocked = evidence.some((item) => item.isError);
          const status =
            run.stopReason === "cancelled"
              ? "cancelled"
              : run.stopReason || unresolved.length
                ? "partial"
                : error || lastStop === "error" || lastStop === "aborted"
                  ? "failed"
                  : blocked
                    ? successful
                      ? "partial"
                      : "blocked"
                    : "completed";
          result = {
            schemaVersion: 1,
            taskId: run.id,
            description: args.description,
            status,
            summary: summary.slice(0, MAX_HANDOFF_CHARS),
            evidenceRefs: refs.slice(0, MAX_TOOL_EVIDENCE),
            artifacts: artifacts.slice(0, MAX_TOOL_EVIDENCE),
            usage: { ...run.usage },
            unresolved,
            acceptance: (args.acceptance ?? []).map((criterion) => ({
              criterion,
              status: "unverified",
              evidenceRefs: [],
            })),
            toolEvidence: evidence.slice(0, MAX_TOOL_EVIDENCE),
          };
          // 终态事件在 run.dispose 之前发射：面板据此结束计时并展示摘要。
          emitActivity(result.status, { summary: result.summary, endedAt: Date.now() });
        } finally {
          unsubscribe?.();
          run.signal.removeEventListener("abort", abort);
          try {
            cancelPermissions();
          } finally {
            try {
              await session?.dispose();
            } finally {
              lease?.release();
              run.dispose();
            }
          }
        }
      }
      return toolResult(result!);
    },
  };
}
