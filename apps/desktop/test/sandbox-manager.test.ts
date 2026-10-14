/**
 * SandboxService（harness 封装层）集成测试：
 * - ensureReady 的状态机（macOS 应 active）
 * - 网络审批回调：未知域名经回调放行后可通；拒绝则不通
 * - 会话级放行集合：第二次访问同域名不再触发回调
 *
 * 独立文件的原因：SandboxManager 是库级单例，initialize 一次后不可重来，
 * 与 sandbox-exec.test.ts 里的直接用法必须分进程（vitest 每文件一 worker）。
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX_SETTINGS } from "@spcode/shared";
import { getSandboxService, resetSandboxServiceForTest } from "../src/agent-host/sandbox/manager.js";

const execFileP = promisify(execFile);
const isMac = process.platform === "darwin";

describe.skipIf(!isMac)("SandboxService（macOS 真跑）", () => {
  let workDir: string;
  const askCalls: string[] = [];

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "spcode-svc-work-"));
    resetSandboxServiceForTest();
    const svc = getSandboxService();
    svc.configure(DEFAULT_SANDBOX_SETTINGS);
    svc.setNetworkAskHandler(async (host) => {
      askCalls.push(host);
      return host === "example.com";
    });
  });

  afterAll(async () => {
    rmSync(workDir, { recursive: true, force: true });
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    await SandboxManager.reset().catch(() => {});
    resetSandboxServiceForTest();
  });

  async function run(wrapped: string): Promise<string> {
    try {
      const { stdout, stderr } = await execFileP("/bin/bash", ["-c", wrapped], { cwd: workDir, timeout: 25_000 });
      return `${stdout}\n${stderr}`;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      return `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    }
  }

  it("macOS 下 ensureReady → active", async () => {
    const svc = getSandboxService();
    const state = await svc.ensureReady();
    expect(state.state).toBe("active");
  }, 30_000);

  it("未知域名触发审批回调，放行后可通；二次访问不再询问", async () => {
    const svc = getSandboxService();
    expect((await svc.ensureReady()).state).toBe("active");

    const first = await svc.wrap("curl -sS -m 15 -o /dev/null -w '%{http_code}' https://example.com", workDir);
    const out1 = await run(first.command);
    expect(askCalls).toContain("example.com");
    expect(out1.trim()).toMatch(/^[234]\d\d/);
    expect(svc.approvedHostsSnapshot()).toContain("example.com");

    const before = askCalls.length;
    const second = await svc.wrap("curl -sS -m 15 -o /dev/null -w '%{http_code}' https://example.com", workDir);
    await run(second.command);
    expect(askCalls.length).toBe(before); // 会话放行集命中，不再问
  }, 60_000);

  it("回调拒绝的域名不通", async () => {
    const svc = getSandboxService();
    const { command } = await svc.wrap("curl -sS -m 10 https://denied-by-callback-xyz.com 2>&1", workDir);
    const out = await run(command);
    expect(askCalls).toContain("denied-by-callback-xyz.com");
    expect(out).toMatch(/403|denied|Could not|failed/i);
  }, 40_000);
});
