/** @vitest-environment jsdom */
/**
 * 关于页软件更新：手动检查按钮、状态行反馈、共用更新弹窗入口，
 * 以及从通用页迁入的「启动时检查更新 / 接收测试版更新」两个开关。
 */
import { DEFAULT_SETTINGS, type UpdateState } from "@spcode/shared";
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../src/renderer/src/components/SettingsPage.js";

const store = vi.hoisted(() => ({
  settings: null as Record<string, unknown> | null,
  saveSettings: vi.fn(),
  updateState: { status: "idle" } as UpdateState,
}));
vi.mock("../src/renderer/src/store", () => ({
  useStore: (selector: (state: typeof store) => unknown) => selector(store),
}));

let root: Root;
let mount: HTMLDivElement;
let updateCheck: ReturnType<typeof vi.fn>;
let updateDownload: ReturnType<typeof vi.fn>;
let updateInstall: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  store.settings = { ...DEFAULT_SETTINGS };
  store.saveSettings.mockReset();
  store.updateState = { status: "idle" };
  updateCheck = vi.fn().mockResolvedValue(true);
  updateDownload = vi.fn().mockResolvedValue(undefined);
  updateInstall = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "spcode", {
    configurable: true,
    value: {
      getAppVersion: vi.fn().mockResolvedValue("0.1.0-beta.41"),
      updateCheck,
      updateDownload,
      updateInstall,
      updateIgnore: vi.fn().mockResolvedValue(undefined),
      autoLaunchStatus: vi.fn().mockResolvedValue({ supported: false, openAtLogin: false }),
    },
  });
  mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
});

afterEach(async () => {
  await act(async () => root.unmount());
  mount.remove();
  Reflect.deleteProperty(window, "spcode");
  vi.unstubAllGlobals();
  setLocale("zh-CN");
});

async function renderAbout() {
  await act(async () =>
    root.render(createElement(I18nextProvider, { i18n }, createElement(SettingsPage, { onClose: vi.fn() }))),
  );
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="settings-nav-about"]')!.click());
}

async function rerender() {
  await act(async () =>
    root.render(createElement(I18nextProvider, { i18n }, createElement(SettingsPage, { onClose: vi.fn() }))),
  );
}

function element<T extends HTMLElement = HTMLButtonElement>(id: string): T {
  return document.querySelector<T>(`[data-testid="${id}"]`)!;
}

function buttonByText(text: string): HTMLButtonElement {
  return Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text)!;
}

describe("关于页软件更新", () => {
  it("更新开关从通用页迁入关于页；检查更新按钮发起手动检查并给出状态反馈", async () => {
    await act(async () =>
      root.render(createElement(I18nextProvider, { i18n }, createElement(SettingsPage, { onClose: vi.fn() }))),
    );
    // 通用页不再有自动更新分区
    expect(document.body.textContent).not.toContain("启动时检查更新");
    expect(document.body.textContent).not.toContain("接收测试版更新");

    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="settings-nav-about"]')!.click());
    expect(element("about-update")).not.toBeNull();
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(2);
    expect(element("update-status-line").textContent).toContain("自动检查");

    await act(async () => element("update-check-now").click());
    expect(updateCheck).toHaveBeenCalledTimes(1);

    store.updateState = { status: "checking" };
    await rerender();
    expect(element("update-check-now").disabled).toBe(true);
    expect(element("update-status-line").textContent).toContain("正在检查更新");

    store.updateState = { status: "up-to-date", version: "0.1.0-beta.41" };
    await rerender();
    expect(element("update-status-line").textContent).toContain("已是最新版本（0.1.0-beta.41）");
    expect(element("update-check-now").disabled).toBe(false);
  });

  it("更新器不可用（返回 false）时内联提示，不伪装成检查成功", async () => {
    updateCheck.mockResolvedValue(false);
    await renderAbout();
    await act(async () => element("update-check-now").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("当前环境无法检查更新");
  });

  it("检查失败（source=check）内联展示原因，按钮仍是重试检查", async () => {
    await renderAbout();
    store.updateState = { status: "error", message: "net::ERR_NAME_NOT_RESOLVED", source: "check" };
    await rerender();
    expect(element("update-status-line").textContent).toContain("检查更新失败");
    expect(element("update-status-line").textContent).toContain("net::ERR_NAME_NOT_RESOLVED");
    expect(element("update-check-now")).not.toBeNull();
    await act(async () => element("update-check-now").click());
    expect(updateCheck).toHaveBeenCalledTimes(1);
  });

  it("发现新版本：主按钮打开共用更新弹窗，确认更新触发下载", async () => {
    await renderAbout();
    store.updateState = { status: "available", version: "0.2.0", releaseNotes: "修复若干问题" };
    await rerender();
    expect(element("update-status-line").textContent).toContain("发现新版本 0.2.0");
    await act(async () => element("update-view").click());
    expect(document.body.textContent).toContain("修复若干问题");
    await act(async () => buttonByText("确认更新").click());
    expect(updateDownload).toHaveBeenCalledTimes(1);
  });

  it("已下载待重启：主按钮打开重启警告弹窗，立即重启触发安装", async () => {
    await renderAbout();
    store.updateState = { status: "downloaded", version: "0.2.0" };
    await rerender();
    expect(element("update-view").textContent).toContain("重启安装");
    await act(async () => element("update-view").click());
    expect(document.body.textContent).toContain("中断正在进行的会话");
    await act(async () => buttonByText("立即重启").click());
    expect(updateInstall).toHaveBeenCalledTimes(1);
  });

  it("两个开关分别持久化 autoUpdate 与 betaUpdates", async () => {
    await renderAbout();
    const switches = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="switch"]'));
    await act(async () => switches[0]!.click());
    expect(store.saveSettings).toHaveBeenCalledWith({ autoUpdate: false });
    // beta 版默认收 beta（跟随版本形态），点击后显式关闭
    await act(async () => switches[1]!.click());
    expect(store.saveSettings).toHaveBeenCalledWith({ betaUpdates: false });
  });
});
