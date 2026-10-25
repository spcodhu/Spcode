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
import { DEFAULT_SANDBOX_SETTINGS } from "@spcode/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSandboxService, resetSandboxServiceForTest } from "../src/agent-host/sandbox/manager.js";

const execFileP = promisify(execFile);
const isMac = process.platform === "darwin";

describe.skipIf(!isMac)("SandboxService（macOS 真跑）", () => {
  let workDir: string;
  let nestedSandboxBlocked = false;
  const askCalls: string[] = [];

  beforeEach((context) => {
    if (nestedSandboxBlocked) context.skip();
  });

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "spcode-svc-work-"));
    resetSandboxServiceForTest();
    const svc = getSandboxService();
    svc.configure(DEFAULT_SANDBOX_SETTINGS);
    svc.setNetworkAskHandler(async (host) => {
      askCalls.push(host);
      return host === "example.com";
    });
    const state = await svc.ensureReady();
    if (state.state === "unavailable" && /EPERM|operation not permitted/i.test(state.reason ?? "")) {
      nestedSandboxBlocked = true;
    }
  });

  afterAll(async () => {
    rmSync(workDir, { recursive: true, force: true });
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    await SandboxManager.reset().catch(() => {});
    resetSandboxServiceForTest();
    // sandbox-runtime 的 reset 要回收代理/子进程，机器繁忙时超 vitest 默认 10s 钩子超时
  }, 30_000);

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

  // 真网用例：默认跳过（离线/CI 不抖），SPCODE_TEST_NETWORK=1 时显式开启
  it.skipIf(!process.env.SPCODE_TEST_NETWORK)(
    "总不询问档：白名单外域名静默放行（不弹窗）且记审计",
    async () => {
      const svc = getSandboxService();
      expect((await svc.ensureReady()).state).toBe("active");
      svc.setModeResolver((id) => (id === "s-never" ? "never" : "ask"));

      const before = askCalls.length;
      const { command, commandId } = await svc.wrap(
        "curl -sS -m 15 -o /dev/null -w '%{http_code}' https://silent-never-xyz.com",
        workDir,
        "s-never",
      );
      await run(command);
      svc.commandFinished(commandId);

      // 只断言「没弹窗、已记审计、不占住归因表」——能不能连通取决于环境出口，不在此断言
      expect(askCalls.length, "never 档不应触发权限弹窗").toBe(before);
      expect(svc.silentlyAllowedHostsSnapshot()).toContain("silent-never-xyz.com");
      expect(svc.inflightSessionSnapshot()).toEqual({});
    },
    60_000,
  );

  it("命令归属：wrap 记录 sessionId，commandFinished 清理", async () => {
    const svc = getSandboxService();
    expect((await svc.ensureReady()).state).toBe("active");
    const { commandId } = await svc.wrap("true", workDir, "s-1");
    expect(svc.inflightSessionSnapshot()).toEqual({ [commandId]: "s-1" });
    svc.commandFinished(commandId);
    expect(svc.inflightSessionSnapshot()).toEqual({});
  }, 30_000);

  // 真网用例：默认跳过（离线/CI 不抖），SPCODE_TEST_NETWORK=1 时显式开启
  it.skipIf(!process.env.SPCODE_TEST_NETWORK)(
    "未知域名触发审批回调，放行后可通；二次访问不再询问",
    async () => {
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
    },
    60_000,
  );

  it("回调拒绝的域名不通", async () => {
    const svc = getSandboxService();
    const { command } = await svc.wrap("curl -sS -m 10 https://denied-by-callback-xyz.com 2>&1", workDir);
    const out = await run(command);
    expect(askCalls).toContain("denied-by-callback-xyz.com");
    expect(out).toMatch(/403|denied|Could not|failed/i);
  }, 40_000);

  it("allowLocalBinding 默认开：沙盒内可监听本地端口（dev server 场景）", async () => {
    const svc = getSandboxService();
    expect((await svc.ensureReady()).state).toBe("active");
    // python3 起一次性 HTTP 服务并自访问；allowLocalBinding=false 时 bind 会被内核拒
    const { command } = await svc.wrap(
      "python3 -c \"import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(1); print('bind-ok', s.getsockname()[1]); s.close()\"",
      workDir,
    );
    const out = await run(command);
    expect(out).toContain("bind-ok");
  }, 40_000);
});
