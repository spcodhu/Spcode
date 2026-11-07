import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {} }));

import { type LoginItemAdapter, LoginItemService } from "../src/main/login-item.js";

const setLoginItemSettings = vi.fn();
let snapshot = {
  openAtLogin: false,
  status: "not-registered" as "not-registered" | "enabled" | "requires-approval" | "not-found",
  executableWillLaunchAtLogin: false,
};
const adapter: LoginItemAdapter = {
  getLoginItemSettings: () => snapshot,
  setLoginItemSettings,
};

beforeEach(() => {
  snapshot = { openAtLogin: false, status: "not-registered", executableWillLaunchAtLogin: false };
  setLoginItemSettings.mockReset();
  setLoginItemSettings.mockImplementation(({ openAtLogin }: { openAtLogin: boolean }) => {
    snapshot = {
      openAtLogin,
      status: openAtLogin ? "enabled" : "not-registered",
      executableWillLaunchAtLogin: openAtLogin,
    };
  });
});

describe("系统登录项", () => {
  it("macOS 一键设置后回读开启状态", () => {
    const service = new LoginItemService({ platform: "darwin", packaged: true, adapter });
    expect(service.status()).toMatchObject({ supported: true, openAtLogin: false, macStatus: "not-registered" });
    expect(service.setEnabled(true)).toMatchObject({ supported: true, openAtLogin: true, macStatus: "enabled" });
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
    expect(service.setEnabled(false).openAtLogin).toBe(false);
    expect(setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false });
  });

  it("macOS requires-approval 不伪装成已生效", () => {
    snapshot = { openAtLogin: true, status: "requires-approval", executableWillLaunchAtLogin: false };
    const service = new LoginItemService({ platform: "darwin", packaged: true, adapter });
    expect(service.status()).toMatchObject({ openAtLogin: true, macStatus: "requires-approval" });
  });

  it("Windows 注册项被系统停用时返回实际关闭状态与提示标记", () => {
    snapshot = { openAtLogin: true, status: "not-registered", executableWillLaunchAtLogin: false };
    const service = new LoginItemService({ platform: "win32", packaged: true, adapter });
    expect(service.status()).toMatchObject({ openAtLogin: false, windowsDeactivated: true });
  });

  it("Linux 与未打包开发环境不写系统登录项", () => {
    for (const options of [
      { platform: "linux" as const, packaged: true },
      { platform: "darwin" as const, packaged: false },
    ]) {
      const service = new LoginItemService({ ...options, adapter });
      expect(service.status().supported).toBe(false);
      expect(() => service.setEnabled(true)).toThrow();
    }
    expect(setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("OS 查询失败返回真实错误，设置失败则抛出而非假成功", () => {
    const broken: LoginItemAdapter = {
      getLoginItemSettings: () => {
        throw new Error("OS denied");
      },
      setLoginItemSettings: () => {
        throw new Error("write denied");
      },
    };
    const service = new LoginItemService({ platform: "win32", packaged: true, adapter: broken });
    expect(service.status()).toMatchObject({ supported: true, openAtLogin: false, error: "OS denied" });
    expect(() => service.setEnabled(true)).toThrow("write denied");
  });
});
