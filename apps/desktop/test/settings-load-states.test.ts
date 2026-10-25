/** @vitest-environment jsdom */
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuotaPage } from "../src/renderer/src/components/QuotaPage.js";
import { RemotePage } from "../src/renderer/src/components/RemotePage.js";
import { SettingsPage } from "../src/renderer/src/components/SettingsPage.js";

const store = vi.hoisted(() => ({
  settings: null as any,
  saveSettings: vi.fn(),
  registrySessions: [] as any[],
}));
vi.mock("../src/renderer/src/store", () => ({
  useStore: (selector: (state: typeof store) => unknown) => selector(store),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function remoteStatus(enabled: boolean) {
  return {
    enabled,
    urls: [],
    devices: [],
    pairing: null,
    relay: "disabled",
    tailscale: { available: false, enabled: false, url: null },
    feishu: { state: "disabled", configured: false, pendingBindCode: null, allowlistCount: 0, allowlist: [] },
  };
}

let root: Root;
let container: HTMLDivElement;
let quotaQuery: ReturnType<typeof vi.fn>;
let remoteStatusQuery: ReturnType<typeof vi.fn>;
let command: ReturnType<typeof vi.fn>;
let getAppVersion: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  store.settings = null;
  store.saveSettings.mockReset();
  store.registrySessions = [];
  quotaQuery = vi.fn();
  remoteStatusQuery = vi.fn();
  command = vi.fn();
  getAppVersion = vi.fn().mockResolvedValue("0.0.0-test");
  Object.defineProperty(window, "spcode", {
    configurable: true,
    value: { quotaQuery, remoteStatus: remoteStatusQuery, command, getAppVersion },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, "spcode");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setLocale("zh-CN");
});

async function render(component: ReactElement) {
  await act(async () => root.render(createElement(I18nextProvider, { i18n }, component)));
}

function element<T extends HTMLElement = HTMLButtonElement>(id: string): T {
  return container.querySelector<T>(`[data-testid="${id}"]`)!;
}

async function click(id: string) {
  await act(async () => element(id).click());
}

describe("配额页读取状态", () => {
  it("首载失败显示真实错误和重试，成功返回空数组才显示空态", async () => {
    const request = deferred<any>();
    quotaQuery.mockReturnValueOnce(request.promise).mockResolvedValue([]);
    await render(createElement(QuotaPage));
    expect(element("quota-loading")).not.toBeNull();

    await act(async () => request.reject(new Error("配额服务超时")));
    expect(element("quota-load-error").textContent).toContain("配额服务超时");
    expect(container.querySelector('[data-testid="quota-empty"]')).toBeNull();

    await click("quota-retry");
    expect(container.querySelector('[data-testid="quota-load-error"]')).toBeNull();
    expect(element("quota-empty").textContent).toContain("暂无配额信息");
  });

  it("成功响应仍渲染原有供应商配额结构", async () => {
    quotaQuery.mockResolvedValue([
      {
        provider: "demo",
        label: "Demo Provider",
        configured: true,
        plan: "Pro",
        limits: [],
        updatedAt: 0,
      },
    ]);
    await render(createElement(QuotaPage));
    expect(container.textContent).toContain("Demo Provider");
    expect(container.textContent).toContain("Pro");
    expect(container.querySelector('[data-testid="quota-load-error"]')).toBeNull();
    expect(container.querySelector('[data-testid="quota-empty"]')).toBeNull();
  });
});

describe("远程控制状态读取", () => {
  it("首载失败提供可点击重试，成功后清除错误并恢复介绍", async () => {
    remoteStatusQuery.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(remoteStatus(false));
    await render(createElement(RemotePage));
    expect(element("remote-load-error")).not.toBeNull();
    expect(container.querySelector('[data-testid="remote-intro"]')).toBeNull();

    await click("remote-retry");
    expect(container.querySelector('[data-testid="remote-load-error"]')).toBeNull();
    expect(element("remote-intro")).not.toBeNull();
    expect(remoteStatusQuery).toHaveBeenCalledTimes(2);
  });

  it("刷新失败保留已有状态，下一次刷新成功会清除粘滞错误", async () => {
    vi.useFakeTimers();
    remoteStatusQuery
      .mockResolvedValueOnce(remoteStatus(true))
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(remoteStatus(true));
    await render(createElement(RemotePage));
    expect(element("remote-urls")).not.toBeNull();

    await act(async () => vi.advanceTimersByTime(5000));
    expect(element("remote-load-error")).not.toBeNull();
    expect(element("remote-urls")).not.toBeNull();

    await act(async () => vi.advanceTimersByTime(5000));
    expect(container.querySelector('[data-testid="remote-load-error"]')).toBeNull();
    expect(element("remote-urls")).not.toBeNull();
  });
});

describe("记忆页读取状态", () => {
  it("读取失败不会永久显示加载中，可重试并区分空文件列表", async () => {
    const request = deferred<any>();
    command.mockReturnValueOnce(request.promise).mockResolvedValue({});
    await render(createElement(SettingsPage, { onClose: vi.fn() }));
    await click("settings-nav-memory");
    expect(element("memory-loading")).not.toBeNull();

    await act(async () => request.reject(new Error("记忆目录不可读")));
    expect(element("memory-load-error").textContent).toContain("记忆目录不可读");
    expect(container.querySelector('[data-testid="memory-loading"]')).toBeNull();
    expect(container.querySelector('[data-testid="memory-empty"]')).toBeNull();

    await click("memory-retry");
    expect(container.querySelector('[data-testid="memory-load-error"]')).toBeNull();
    expect(element("memory-empty").textContent).toContain("暂无记忆文件");
  });

  it("成功读取的空白文件显示空内容，而不是读取错误", async () => {
    command.mockResolvedValue({ "MEMORY.md": "  \n" });
    await render(createElement(SettingsPage, { onClose: vi.fn() }));
    await click("settings-nav-memory");
    await click("memory-file-MEMORY.md");
    expect(element("memory-content").textContent).toBe("（空）");
    expect(container.querySelector('[data-testid="memory-load-error"]')).toBeNull();
  });
});
