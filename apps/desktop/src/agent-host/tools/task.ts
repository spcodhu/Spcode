/**
 * Task —— 子代理：把子任务派发给一个隔离上下文的子 AgentSession，
 * 只带回结论。这是上下文管理的核心手段——读 50 个文件的脏活让子代理干，
 * 主上下文只留三行结论。
 *
 * 防递归：会话深度达到 MAX_TASK_DEPTH 后不再提供 Task 工具
 * （主会话 depth=0 → 子代理 depth=1 可再嵌套一层 → depth=2 起无 Task）。
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { PermissionMode, PermissionRequest, SandboxSettings } from "@spcode/shared";
import { resolveSpcodeHome } from "@spcode/shared/node";
import { type Static, Type } from "typebox";
import { installLanguagePolicy } from "../language-policy.js";
import { createBeforeToolCallGate } from "../permission-gate.js";
import { createSandboxedBashTool } from "../sandbox/bash-tool.js";
import { createGuardedFsTools, type FsGuardPolicy } from "../sandbox/fs-guard.js";
import { getSandboxService } from "../sandbox/manager.js";

/** 可获得 Task 工具的会话深度上限：0=主会话、1=子代理可嵌套，2 起不再提供 */
const MAX_TASK_DEPTH = 2;

const taskSchema = Type.Object({
  description: Type.String({
    description:
      "Short task title (3-8 words) shown to the user, in the current UI language unless explicitly requested otherwise",
  }),
  prompt: Type.String({ description: "Complete, self-contained instructions for the subagent" }),
});

type Params = Static<typeof taskSchema>;

export interface TaskToolContext {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  model: Model<never> | undefined;
  thinkingLevel: string;
  depth: number;
  /** 沙盒设置 getter（主会话透传；子代理 bash 与主会话同边界） */
  getSandboxSettings?: () => SandboxSettings;
  /** 权限模式 getter（主会话透传；子代理与主会话同档位） */
  getPermissionMode?: () => PermissionMode;
  /** 权限网关通道（主会话透传，评审 R3-C4：子代理的写/危险操作同样弹窗裁决） */
  requestPermission: (req: PermissionRequest) => Promise<boolean>;
}

export function createTaskTool(ctx: TaskToolContext): ToolDefinition {
  return {
    name: "Task",
    label: "Task (subagent)",
    description:
      "Spawn a subagent with an isolated context to handle a focused subtask (e.g. reading many files, exploratory search, self-testing). The subagent runs autonomously and only its final conclusion returns to you. Give it complete, self-contained instructions — it cannot see this conversation.",
    promptSnippet: "Delegate focused subtasks to an isolated subagent",
    parameters: taskSchema,
    executionMode: "parallel",
    execute: async (_id, args: Params, signal) => {
      // 子代理与主会话同一沙盒边界：服务是进程级单例，主会话创建时已 configure
      const sandbox = getSandboxService();
      if (ctx.getSandboxSettings) sandbox.configure(ctx.getSandboxSettings());
      const sandboxState = await sandbox.ensureReady();
      // 文件路径守卫与主会话同策略（R3-C3/C4）：子会话注册守卫版 read/write/edit
      const getFsPolicy = (): FsGuardPolicy => {
        const sb = ctx.getSandboxSettings?.();
        return {
          cwd: ctx.cwd,
          spcodeHome: resolveSpcodeHome(),
          extraDenyRead: sb?.filesystem.extraDenyRead ?? [],
          extraAllowWrite: sb?.filesystem.extraAllowWrite ?? [],
        };
      };
      const customTools: ToolDefinition[] = [
        // 子会话沙盒 bash：不开放 dangerouslyDisableSandbox 逃生舱参数
        // （逃生舱批准权属用户与主会话，子代理不得自行申请）
        ...(sandboxState.state === "active" ? [createSandboxedBashTool(ctx.cwd, { allowBypass: false })] : []),
        ...createGuardedFsTools(ctx.cwd, getFsPolicy),
        // 子会话深度 +1；达到上限后子会话不再拿到 Task（评审 P2-5：让条件与头注释同口径）
        ...(ctx.depth + 1 < MAX_TASK_DEPTH ? [createTaskTool({ ...ctx, depth: ctx.depth + 1 })] : []),
      ];
      const { session } = await createAgentSession({
        cwd: ctx.cwd,
        agentDir: ctx.agentDir,
        modelRuntime: ctx.modelRuntime,
        model: ctx.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        thinkingLevel: ctx.thinkingLevel as any,
        sessionManager: SessionManager.inMemory(),
        customTools: customTools.length > 0 ? customTools : undefined,
      });
      installLanguagePolicy(session.agent);
      // 权限网关（R3-C4）：子代理与主会话同一裁决链（计划模式例外——计划模式下 Task 不挂载）
      session.agent.beforeToolCall = createBeforeToolCallGate({
        sessionId: `task-subagent@${ctx.cwd}`,
        isPlanMode: () => false,
        getPermissionMode: ctx.getPermissionMode,
        getFsPolicy,
        getSandboxSettings: ctx.getSandboxSettings,
        sandboxState,
        requestPermission: ctx.requestPermission,
      });
      try {
        const onAbort = () => void session.abort();
        signal?.addEventListener("abort", onAbort);
        await session.prompt(args.prompt);
        signal?.removeEventListener("abort", onAbort);
        const text = session.getLastAssistantText();
        return {
          content: [
            {
              type: "text",
              text: `# Subagent result: ${args.description}\n\n${text || "(subagent produced no text output)"}`,
            },
          ],
          details: {
            description: args.description,
            presentation: text
              ? { key: "agent:tool.taskResult", params: { description: args.description, result: text } }
              : { key: "agent:tool.taskEmptyResult", params: { description: args.description } },
          },
        };
      } finally {
        await session.dispose();
      }
    },
  };
}
