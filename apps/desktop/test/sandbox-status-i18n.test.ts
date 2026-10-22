import { DEFAULT_SANDBOX_SETTINGS } from "@spcode/shared";
import { renderMessage, setLocale } from "@spcode/shared/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  initialize: vi.fn(),
  updateConfig: vi.fn(),
  checkDependenciesAsync: vi.fn(),
  wrapWithSandbox: vi.fn(),
}));
vi.mock("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: runtime }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: () => true,
}));

import { getSandboxService, resetSandboxServiceForTest } from "../src/agent-host/sandbox/manager.js";

beforeEach(() => {
  vi.clearAllMocks();
  runtime.initialize.mockResolvedValue(undefined);
  runtime.checkDependenciesAsync.mockResolvedValue({ errors: [] });
  setLocale("zh-CN");
  resetSandboxServiceForTest();
});
afterEach(() => {
  setLocale("zh-CN");
  resetSandboxServiceForTest();
});

describe("sandbox status localization (mock runtime only)", () => {
  it("does not change the disabled guard or initialize a disabled sandbox", async () => {
    const svc = getSandboxService();
    svc.configure({ ...DEFAULT_SANDBOX_SETTINGS, enabled: false });
    expect(svc.status()).toEqual({ state: "disabled" });
    await expect(svc.wrap("never executed", "/unused")).rejects.toThrow("Sandbox is disabled; wrap must not be called");
    expect(runtime.initialize).not.toHaveBeenCalled();
    expect(runtime.wrapWithSandbox).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "renders uninitialized status in the current locale",
    () => {
      const svc = getSandboxService();
      svc.configure({ ...DEFAULT_SANDBOX_SETTINGS, enabled: true });
      expect(svc.status()).toMatchObject({ state: "unavailable", reason: "沙盒尚未初始化" });
      setLocale("en");
      expect(svc.status()).toMatchObject({ state: "unavailable", reason: "Sandbox has not been initialized" });
    },
  );

  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "re-renders cached failures but keeps model errors canonical and fail-closed",
    async () => {
      runtime.initialize.mockRejectedValue(new Error("RAW_RUNTIME_ERROR <原文>"));
      const svc = getSandboxService();
      svc.configure({ ...DEFAULT_SANDBOX_SETTINGS, enabled: true });
      const zh = await svc.ensureReady();
      expect(zh).toMatchObject({ state: "unavailable", reason: "沙盒初始化失败：RAW_RUNTIME_ERROR <原文>" });
      if (zh.state !== "unavailable" || !zh.reasonMessage) throw new Error("Expected a reason descriptor");
      setLocale("en");
      expect(renderMessage(zh.reasonMessage)).toBe("Sandbox initialization failed: RAW_RUNTIME_ERROR <原文>");
      expect(await svc.ensureReady()).toMatchObject({
        state: "unavailable",
        reason: "Sandbox initialization failed: RAW_RUNTIME_ERROR <原文>",
      });
      setLocale("zh-CN");
      await expect(svc.wrap("never executed", "/unused")).rejects.toThrow(
        "Sandbox unavailable: Sandbox initialization failed: RAW_RUNTIME_ERROR <原文>",
      );
      expect(runtime.initialize).toHaveBeenCalledTimes(1);
      expect(runtime.wrapWithSandbox).not.toHaveBeenCalled();
    },
  );
});
