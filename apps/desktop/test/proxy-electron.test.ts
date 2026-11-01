import { DEFAULT_NETWORK_PROXY_SETTINGS } from "@spcode/shared/proxy";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setDefaultProxy: vi.fn<(config: unknown) => Promise<void>>(),
  setUpdaterProxy: vi.fn<(config: unknown) => Promise<void>>(),
  configureNode: vi.fn(),
  on: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { on: mocks.on },
  session: {
    defaultSession: { setProxy: mocks.setDefaultProxy },
    fromPartition: vi.fn(() => ({ setProxy: mocks.setUpdaterProxy })),
  },
}));
vi.mock("../src/network-proxy.js", () => ({ configureNetworkProxy: mocks.configureNode }));

import { applyNetworkProxy, registerNetworkProxyAuthentication } from "../src/main/proxy.js";

beforeEach(() => {
  mocks.setDefaultProxy.mockReset().mockResolvedValue();
  mocks.setUpdaterProxy.mockReset().mockResolvedValue();
  mocks.configureNode.mockReset();
  mocks.on.mockReset();
});

describe("Electron 代理适配", () => {
  it("默认 session 与 electron-updater session 同步配置，关闭时显式恢复 direct", async () => {
    const config = {
      ...DEFAULT_NETWORK_PROXY_SETTINGS,
      enabled: true,
      host: "proxy.example.com",
      port: 8080,
      username: "u",
      password: "p",
    };
    await applyNetworkProxy(config);
    expect(mocks.configureNode).toHaveBeenCalledWith(config);
    const expected = { mode: "fixed_servers", proxyRules: "http://proxy.example.com:8080" };
    expect(mocks.setDefaultProxy).toHaveBeenCalledWith(expected);
    expect(mocks.setUpdaterProxy).toHaveBeenCalledWith(expected);

    await applyNetworkProxy(DEFAULT_NETWORK_PROXY_SETTINGS);
    expect(mocks.setDefaultProxy).toHaveBeenLastCalledWith({ mode: "direct" });
    expect(mocks.setUpdaterProxy).toHaveBeenLastCalledWith({ mode: "direct" });
  });

  it("仅对当前代理的 login 事件回传凭据，不截获其他认证", () => {
    registerNetworkProxyAuthentication(() => ({
      ...DEFAULT_NETWORK_PROXY_SETTINGS,
      enabled: true,
      host: "proxy.example.com",
      port: 8080,
      username: "user",
      password: "secret",
    }));
    const login = mocks.on.mock.calls.find(([event]) => event === "login")?.[1] as (
      event: { preventDefault: () => void },
      webContents: null,
      details: unknown,
      authInfo: { isProxy: boolean; host: string; port: number },
      callback: (username: string, password: string) => void,
    ) => void;
    expect(login).toBeTypeOf("function");
    const preventDefault = vi.fn();
    const callback = vi.fn();
    login({ preventDefault }, null, {}, { isProxy: true, host: "proxy.example.com", port: 8080 }, callback);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith("user", "secret");

    const otherPrevent = vi.fn();
    const otherCallback = vi.fn();
    login(
      { preventDefault: otherPrevent },
      null,
      {},
      { isProxy: true, host: "other.example.com", port: 8080 },
      otherCallback,
    );
    expect(otherPrevent).not.toHaveBeenCalled();
    expect(otherCallback).not.toHaveBeenCalled();
  });
});
