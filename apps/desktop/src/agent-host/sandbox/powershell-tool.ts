/**
 * Windows PowerShell 的宿主契约：复用会话 spawnHook，并与 Bash 共用有界超时。
 * 这里不提供或宣称 OS 沙盒；权限仍由统一 beforeToolCall 网关裁决。
 */
import {
  type BashOperations,
  createPowerShellToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { SessionToolEnvironment } from "../tool-environment.js";
import { effectiveShellTimeout, SHELL_TIMEOUT_DESCRIPTION_NOTE, shellTimeoutField } from "./shell-contract.js";

const powershellSchema = Type.Object({
  command: Type.String({ description: "PowerShell command to execute" }),
  timeout: shellTimeoutField,
});

type Params = Static<typeof powershellSchema>;

export function createManagedPowerShellTool(
  cwd: string,
  options: { environment?: SessionToolEnvironment; operations?: BashOperations } = {},
): ToolDefinition {
  const base = createPowerShellToolDefinition(cwd, {
    spawnHook: options.environment?.spawnHook,
    operations: options.operations,
  });
  return {
    ...base,
    description: base.description + SHELL_TIMEOUT_DESCRIPTION_NOTE,
    parameters: powershellSchema,
    execute: async (toolCallId: string, params: Params, signal: AbortSignal | undefined, onUpdate: never, ctx: never) =>
      base.execute(
        toolCallId,
        { command: params.command, timeout: effectiveShellTimeout(params.timeout) },
        signal,
        onUpdate,
        ctx,
      ),
  } as unknown as ToolDefinition;
}
