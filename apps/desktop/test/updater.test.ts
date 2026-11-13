import type { UpdateState } from "@spcode/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    handlers,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn<() => Promise<null>>(),
    downloadUpdate: vi.fn<() => Promise<string[]>>(),
    quitAndInstall: vi.fn(),
  };
});

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.1.0-beta.35" },
}));

vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: {
      on: mocks.on,
      setFeedURL: mocks.setFeedURL,
      checkForUpdates: mocks.checkForUpdates,
      downloadUpdate: mocks.downloadUpdate,
      quitAndInstall: mocks.quitAndInstall,
    },
  },
}));

async function setupUpdater() {
  const updater = await import("../src/main/updater.js");
  const states: UpdateState[] = [];
  updater.setupAutoUpdater({
    isEnabled: () => true,
    getBetaUpdates: () => true,
    getIgnoredVersion: () => undefined,
    onState: (state) => states.push(state),
  });
  return { updater, states };
}

async function flushPromises() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.resetModules();
  mocks.handlers.clear();
  mocks.on.mockClear();
  mocks.setFeedURL.mockReset();
  mocks.checkForUpdates.mockReset().mockResolvedValue(null);
  mocks.downloadUpdate.mockReset().mockResolvedValue([]);
  mocks.quitAndInstall.mockReset();
});

describe("自动更新错误边界", () => {
  it("后台检查网络失败时保持 idle，不显示更新失败按钮", async () => {
    const error = new Error("net::ERR_CONNECTION_RESET");
    mocks.checkForUpdates.mockImplementation(() => {
      // 与 electron-updater 一致：先 emit error，再拒绝检查 Promise。
      mocks.handlers.get("error")?.(error);
      return Promise.reject(error);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { updater, states } = await setupUpdater();
    await flushPromises();

    expect(updater.getUpdateState()).toEqual({ status: "idle" });
    expect(states).toEqual([]);
    expect(warn).toHaveBeenCalledWith("[updater] check failed", error);
    warn.mockRestore();
  });

  it("明确没有新版本时保持 idle", async () => {
    const { updater } = await setupUpdater();
    await flushPromises();

    mocks.handlers.get("update-not-available")?.({ version: "0.1.0-beta.35" });

    expect(updater.getUpdateState()).toEqual({ status: "idle" });
  });

  it("用户主动下载失败时仍展示错误与重试入口", async () => {
    const { updater } = await setupUpdater();
    await flushPromises();
    mocks.handlers.get("update-available")?.({ version: "0.2.0", releaseNotes: "修复问题" });
    expect(updater.getUpdateState()).toMatchObject({ status: "available", version: "0.2.0" });

    const error = new Error("download failed");
    mocks.downloadUpdate.mockImplementation(() => {
      mocks.handlers.get("error")?.(error);
      return Promise.reject(error);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    updater.downloadUpdate();
    await flushPromises();

    expect(updater.getUpdateState()).toEqual({ status: "error", message: "download failed" });
    warn.mockRestore();
  });
});
