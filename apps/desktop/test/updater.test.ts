import type { UpdateState } from "@spcode/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    handlers,
    packaged: { value: true },
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
  app: {
    get isPackaged() {
      return mocks.packaged.value;
    },
    getVersion: () => "0.1.0-beta.35",
  },
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

async function setupUpdater(opts?: { enabled?: boolean; ignoredVersion?: string }) {
  const updater = await import("../src/main/updater.js");
  const states: UpdateState[] = [];
  updater.setupAutoUpdater({
    isEnabled: () => opts?.enabled ?? true,
    getBetaUpdates: () => true,
    getIgnoredVersion: () => opts?.ignoredVersion,
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
  mocks.packaged.value = true;
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

    expect(updater.getUpdateState()).toEqual({ status: "error", message: "download failed", source: "download" });
    warn.mockRestore();
  });
});

describe("关于页手动检查", () => {
  it("无新版本：checking → up-to-date，带当前版本号", async () => {
    const { updater } = await setupUpdater();
    await flushPromises();

    expect(updater.checkForUpdatesNow()).toBe(true);
    expect(updater.getUpdateState()).toEqual({ status: "checking" });
    mocks.handlers.get("update-not-available")?.({ version: "0.1.0-beta.35" });
    expect(updater.getUpdateState()).toEqual({ status: "up-to-date", version: "0.1.0-beta.35" });
    await flushPromises();
  });

  it("autoUpdate 关闭时手动检查仍然发起（用户显式动作不受开关限制）", async () => {
    const { updater } = await setupUpdater({ enabled: false });
    await flushPromises();
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();

    expect(updater.checkForUpdatesNow()).toBe(true);
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.getUpdateState()).toEqual({ status: "checking" });
  });

  it("手动检查失败透出 source=check 的错误，可再次重试", async () => {
    const { updater } = await setupUpdater();
    await flushPromises();
    const error = new Error("net::ERR_NAME_NOT_RESOLVED");
    mocks.checkForUpdates.mockImplementationOnce(() => {
      mocks.handlers.get("error")?.(error);
      return Promise.reject(error);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    updater.checkForUpdatesNow();
    expect(updater.getUpdateState()).toEqual({
      status: "error",
      message: "net::ERR_NAME_NOT_RESOLVED",
      source: "check",
    });
    await flushPromises();

    updater.checkForUpdatesNow();
    expect(updater.getUpdateState()).toEqual({ status: "checking" });
    warn.mockRestore();
  });

  it("发现新版本进入 available；被忽略的版本手动检查等价于没有可更新版本", async () => {
    const { updater } = await setupUpdater({ ignoredVersion: "0.2.0" });
    await flushPromises();

    updater.checkForUpdatesNow();
    mocks.handlers.get("update-available")?.({ version: "0.2.0", releaseNotes: "" });
    expect(updater.getUpdateState()).toEqual({ status: "up-to-date", version: "0.1.0-beta.35" });
    await flushPromises();

    updater.checkForUpdatesNow();
    mocks.handlers.get("update-available")?.({ version: "0.3.0", releaseNotes: "新功能" });
    expect(updater.getUpdateState()).toMatchObject({ status: "available", version: "0.3.0" });
  });

  it("下载中/已下载待重启时不重复发起检查，也不被后台复查打回 available", async () => {
    const { updater } = await setupUpdater();
    await flushPromises();
    mocks.handlers.get("update-available")?.({ version: "0.2.0", releaseNotes: "" });
    mocks.handlers.get("update-downloaded")?.({ version: "0.2.0" });
    expect(updater.getUpdateState()).toEqual({ status: "downloaded", version: "0.2.0" });

    const calls = mocks.checkForUpdates.mock.calls.length;
    expect(updater.checkForUpdatesNow()).toBe(true);
    expect(mocks.checkForUpdates.mock.calls.length).toBe(calls);
    expect(updater.getUpdateState()).toEqual({ status: "downloaded", version: "0.2.0" });

    // 后台每 4 小时复查：同版本 update-available / update-not-available 都不得覆盖待重启状态
    mocks.handlers.get("update-available")?.({ version: "0.2.0", releaseNotes: "" });
    mocks.handlers.get("update-not-available")?.({ version: "0.2.0" });
    expect(updater.getUpdateState()).toEqual({ status: "downloaded", version: "0.2.0" });
  });

  it("开发运行（更新器未初始化）手动检查返回 false", async () => {
    mocks.packaged.value = false;
    const { updater } = await setupUpdater();
    await flushPromises();
    expect(updater.checkForUpdatesNow()).toBe(false);
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
  });
});
