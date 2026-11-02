/**
 * 沙盒开关热更新：同一个 Bash 工具实例在设置变化后，下一条命令即切换执行路径。
 * 不测内核行为（sandbox-exec.test.ts 负责），只钉住动态决策与同一会话环境。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SANDBOX_SETTINGS, type SandboxSettings } from "@spcode/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxedBashTool } from "../src/agent-host/sandbox/bash-tool.js";
import { getSandboxService, resetSandboxServiceForTest, type SandboxState } from "../src/agent-host/sandbox/manager.js";

let cwd = "";
let settings: SandboxSettings;
let state: SandboxState;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "spcode-hot-sandbox-"));
  settings = { ...DEFAULT_SANDBOX_SETTINGS, enabled: false };
  state = { state: "disabled" };
  resetSandboxServiceForTest();
  const svc = getSandboxService();
  vi.spyOn(svc, "ensureReady").mockImplementation(async () => state);
  vi.spyOn(svc, "wrap").mockImplementation(async (command) => ({ command, commandId: "hot-command" }));
  vi.spyOn(svc, "violations").mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSandboxServiceForTest();
  rmSync(cwd, { recursive: true, force: true });
});

async function run(
  tool: ReturnType<typeof createSandboxedBashTool>,
  command: string,
): Promise<string> {
  const result = await tool.execute("t1", { command }, undefined, undefined as never, undefined as never);
  return String(result.content?.[0]?.text ?? "");
}

describe("Bash 工具沙盒开关热更新", () => {
  it("关 → 开 → 关：同一工具实例逐次读取最新设置", async () => {
    const tool = createSandboxedBashTool(cwd, {
      allowBypass: true,
      getSettings: () => settings,
    });
    const svc = getSandboxService();
    const wrap = vi.mocked(svc.wrap);

    expect(await run(tool, "echo local-before")).toContain("local-before");
    expect(wrap).not.toHaveBeenCalled();

    settings = { ...settings, enabled: true };
    state = { state: "active" };
    expect(await run(tool, "echo sandboxed-after")).toContain("sandboxed-after");
    expect(wrap).toHaveBeenCalledTimes(1);

    settings = { ...settings, enabled: false };
    state = { state: "disabled" };
    expect(await run(tool, "echo local-again")).toContain("local-again");
    expect(wrap).toHaveBeenCalledTimes(1);
  });

  it("设置开启但依赖不可用时退回本地，不破坏跨平台降级", async () => {
    settings = { ...settings, enabled: true };
    state = { state: "unavailable", reason: "missing dependencies" };
    const tool = createSandboxedBashTool(cwd, { allowBypass: false, getSettings: () => settings });

    expect(await run(tool, "echo degraded-ok")).toContain("degraded-ok");
    expect(getSandboxService().wrap).not.toHaveBeenCalled();
  });
});
