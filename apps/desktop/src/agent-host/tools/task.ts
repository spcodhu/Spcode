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
import type { SandboxSettings } from "@spcode/shared";
import { type Static, Type } from "typebox";
import { createSandboxedBashTool } from "../sandbox/bash-tool.js";
import { getSandboxService } from "../sandbox/manager.js";

/** 可获得 Task 工具的会话深度上限：0=主会话、1=子代理可嵌套，2 起不再提供 */
const MAX_TASK_DEPTH = 2;

const taskSchema = Type.Object({
  description: Type.String({ description: "Short task title (3-8 words) shown to the user" }),
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
      const customTools: ToolDefinition[] = [
        // 子会话不挂权限网关（无 beforeToolCall），沙盒是唯一防线——绝不能给子代理
        // 开放 dangerouslyDisableSandbox 逃生舱参数，否则就是无审批逃逸口
        ...(sandboxState.state === "active" ? [createSandboxedBashTool(ctx.cwd, { allowBypass: false })] : []),
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
      try {
        const onAbort = () => void session.abort();
        signal?.addEventListener("abort", onAbort);
        await session.prompt(args.prompt);
        signal?.removeEventListener("abort", onAbort);
        const text = session.getLastAssistantText() || "(subagent produced no text output)";
        return {
          content: [{ type: "text", text: `# Subagent result: ${args.description}\n\n${text}` }],
          details: { description: args.description },
        };
      } finally {
        await session.dispose();
      }
    },
  };
}
