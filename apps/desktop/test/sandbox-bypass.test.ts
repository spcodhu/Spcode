/**
 * 沙盒逃生舱（dangerouslyDisableSandbox）与沙盒外白名单（excludedCommands）单测。
 *
 * 不测内核行为（那是 sandbox-exec.test.ts 的职责），只测封装层决策：
 * - 逃生舱参数只在 allowBypass=true 的工具上暴露（子代理堵死逃逸口）
 * - bypass=true → 不经 wrap 直接本地执行（沙盒服务未初始化也能跑通）
 * - excludedCommands 前缀命中 → 不经 wrap 直接本地执行
 * - 普通命令在沙盒不可用时 fail-closed（exit 126，绝不裸跑）
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SANDBOX_SETTINGS, type SandboxSettings } from "@spcode/shared";
import { describe, expect, it } from "vitest";
import { createSandboxedBashTool, matchesExcludedCommand } from "../src/agent-host/sandbox/bash-tool.js";
import { resetSandboxServiceForTest } from "../src/agent-host/sandbox/manager.js";

interface ToolResultLike {
  content: { type: string; text?: string }[];
  details?: unknown;
}

function makeSettings(over?: Partial<SandboxSettings>): SandboxSettings {
  return {
    ...DEFAULT_SANDBOX_SETTINGS,
    ...over,
    network: { ...DEFAULT_SANDBOX_SETTINGS.network, ...over?.network },
    filesystem: { ...DEFAULT_SANDBOX_SETTINGS.filesystem, ...over?.filesystem },
  };
}

function makeTool(opts: { allowBypass: boolean; settings?: SandboxSettings }) {
  resetSandboxServiceForTest();
  const cwd = mkdtempSync(join(tmpdir(), "spcode-bypass-test-"));
  // 沙盒服务不 configure → status 恒 unavailable → wrap 必失败（fail-closed 路径）
  return createSandboxedBashTool(cwd, {
    allowBypass: opts.allowBypass,
    getSettings: () => opts.settings ?? makeSettings(),
  });
}

async function run(
  tool: ReturnType<typeof makeTool>,
  params: { command: string; dangerouslyDisableSandbox?: boolean },
): Promise<{ exitCode: number | null; text: string }> {
  try {
    const r = (await tool.execute("t1", params as never, undefined, undefined, undefined as never)) as ToolResultLike;
    return { exitCode: 0, text: r.content.map((c) => c.text ?? "").join("") };
  } catch (err) {
    // pi 的 bash 工具在非零退出码时抛错，消息尾部带 exit code
    return { exitCode: null, text: err instanceof Error ? err.message : String(err) };
  }
}

describe("matchesExcludedCommand", () => {
  it("前缀 + token 边界匹配，复合命令只看首段", () => {
    expect(matchesExcludedCommand("pnpm test:e2e --grep x", "pnpm test:e2e")).toBe(true);
    expect(matchesExcludedCommand("pnpm test:e2e", "pnpm test:e2e")).toBe(true);
    expect(matchesExcludedCommand("pnpm test:e2e-extra", "pnpm test:e2e")).toBe(false);
    expect(matchesExcludedCommand("echo hi && pnpm test:e2e", "pnpm test:e2e")).toBe(false);
  });
});

describe("逃生舱参数暴露", () => {
  it("allowBypass=true 的工具有 dangerouslyDisableSandbox 参数", () => {
    const tool = makeTool({ allowBypass: true });
    expect(tool.parameters).toHaveProperty("properties.dangerouslyDisableSandbox");
  });

  it("allowBypass=false（子代理）的工具没有逃生舱参数", () => {
    const tool = makeTool({ allowBypass: false });
    expect(tool.parameters).not.toHaveProperty("properties.dangerouslyDisableSandbox");
  });
});

describe("执行路径", () => {
  it("bypass=true → 不经沙盒直接执行（沙盒不可用也能跑通）", async () => {
    const tool = makeTool({ allowBypass: true });
    const r = await run(tool, { command: "echo bypass-ok", dangerouslyDisableSandbox: true });
    expect(r.text).toContain("bypass-ok");
    expect(r.text).not.toContain("sandbox wrapping failed");
  });

  it("excludedCommands 命中 → 不经沙盒直接执行", async () => {
    const tool = makeTool({
      allowBypass: false,
      settings: makeSettings({ excludedCommands: ["echo excluded"] }),
    });
    const r = await run(tool, { command: "echo excluded && echo done" });
    expect(r.text).toContain("done");
  });

  it("普通命令在沙盒不可用时 fail-closed（exit 126，不裸跑）", async () => {
    const tool = makeTool({ allowBypass: true });
    const r = await run(tool, { command: "echo should-not-run" });
    expect(r.text).toContain("sandbox wrapping failed");
    expect(r.text).not.toContain("should-not-run\n");
  });

  it("bypass=false 的调用即使带 flag 字段也走沙盒路径（fail-closed）", async () => {
    const tool = makeTool({ allowBypass: true });
    const r = await run(tool, { command: "echo via-sandbox", dangerouslyDisableSandbox: false });
    expect(r.text).toContain("sandbox wrapping failed");
  });
});
