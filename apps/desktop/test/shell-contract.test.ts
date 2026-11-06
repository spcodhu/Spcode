import type { BashOperations, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SANDBOX_SETTINGS } from "@spcode/shared";
import { describe, expect, it } from "vitest";
import { createSandboxedBashTool } from "../src/agent-host/sandbox/bash-tool.js";
import { createManagedPowerShellTool } from "../src/agent-host/sandbox/powershell-tool.js";
import {
  DEFAULT_SHELL_TIMEOUT_SECONDS,
  effectiveShellTimeout,
  MAX_SHELL_TIMEOUT_SECONDS,
} from "../src/agent-host/sandbox/shell-contract.js";
import type { SessionToolEnvironment } from "../src/agent-host/tool-environment.js";

interface CapturedCall {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

function captureOperations(calls: CapturedCall[]): BashOperations {
  return {
    exec: async (_command, _cwd, options) => {
      calls.push({ timeout: options.timeout, env: options.env });
      return { exitCode: 0 };
    },
  };
}

function execute(tool: ToolDefinition, args: Record<string, unknown>) {
  return tool.execute("shell-test", args as never, undefined, undefined, undefined as never);
}

describe("Shell 有界超时契约", () => {
  it("默认 120 秒、最大 600 秒，非法值在执行前失败", () => {
    expect(effectiveShellTimeout()).toBe(DEFAULT_SHELL_TIMEOUT_SECONDS);
    expect(effectiveShellTimeout(42)).toBe(42);
    expect(() => effectiveShellTimeout(0)).toThrow("greater than 0");
    expect(() => effectiveShellTimeout(-1)).toThrow("greater than 0");
    expect(() => effectiveShellTimeout(MAX_SHELL_TIMEOUT_SECONDS + 1)).toThrow("at most 600");
    expect(() => effectiveShellTimeout(Number.NaN)).toThrow("finite");
  });

  it("Bash 本地路径注入默认/显式 timeout，并保留 Schema 与 strict-prefer", async () => {
    const calls: CapturedCall[] = [];
    const tool = createSandboxedBashTool(process.cwd(), {
      allowBypass: false,
      localOperations: captureOperations(calls),
      getSettings: () => ({ ...DEFAULT_SANDBOX_SETTINGS, enabled: false }),
    });
    await execute(tool, { command: "true" });
    await execute(tool, { command: "true", timeout: 42 });
    expect(calls.map((call) => call.timeout)).toEqual([120, 42]);
    expect(tool.description).toContain("120 seconds by default");
    expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
    expect(JSON.stringify(tool.parameters)).toContain('"maximum":600');

    await expect(execute(tool, { command: "true", timeout: 601 })).rejects.toThrow("at most 600");
    expect(calls).toHaveLength(2);
  });

  it("PowerShell 复用相同超时和会话 spawnHook 环境", async () => {
    const calls: CapturedCall[] = [];
    const environment: SessionToolEnvironment = {
      pathKey: "PATH",
      path: "/bin",
      tmpdir: "/tmp",
      spawnHook: (context) => ({ ...context, env: { ...context.env, SPCODE_SHELL_TEST: "present" } }),
    };
    const tool = createManagedPowerShellTool(process.cwd(), {
      environment,
      operations: captureOperations(calls),
    });
    await execute(tool, { command: "$true" });
    await execute(tool, { command: "$true", timeout: 45 });
    expect(calls.map((call) => call.timeout)).toEqual([120, 45]);
    expect(calls[0]?.env?.SPCODE_SHELL_TEST).toBe("present");
    expect(tool.description).toContain("maximum 600 seconds");
    expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
  });
});
