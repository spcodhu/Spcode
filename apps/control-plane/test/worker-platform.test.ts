import { getSandboxService, resetSandboxServiceForTest } from "@spcode/agent-runtime/sandbox/manager.js";
import { DEFAULT_SANDBOX_SETTINGS } from "@spcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workerEnvironment } from "../src/git-workspace.js";

afterEach(() => {
  Object.defineProperty(process, "platform", { value: process.platform, configurable: true });
  vi.restoreAllMocks();
  resetSandboxServiceForTest();
});

describe("Windows 进程隔离边界", () => {
  it("明确返回 unavailable，不宣称 OS 沙盒", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const service = getSandboxService();
      service.configure(DEFAULT_SANDBOX_SETTINGS);
      const state = await service.ensureReady();
      expect(state.state).toBe("unavailable");
      if (state.state !== "unavailable") throw new Error("Windows 不应返回 active");
      expect(state.canonicalReason).toMatch(/Windows support is pending upstream readiness/);
      expect(state.reasonMessage).toEqual({ key: "main:sandbox.unsupportedPlatform", params: { platform: "win32" } });
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });

  it("Worker 环境保留 Windows 进程启动必需变量，不带外部写凭据", () => {
    process.env.SYSTEMROOT = "C:\\Windows";
    process.env.COMSPEC = "C:\\Windows\\System32\\cmd.exe";
    process.env.SPCODE_GITHUB_TOKEN = "must-not-leak";
    const env = workerEnvironment();
    expect(env.SYSTEMROOT).toBe("C:\\Windows");
    expect(env.COMSPEC).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(env.SPCODE_GITHUB_TOKEN).toBeUndefined();
    delete process.env.SPCODE_GITHUB_TOKEN;
  });
});
