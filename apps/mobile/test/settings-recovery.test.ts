/** @vitest-environment jsdom */
import { i18n, setLocale } from "@spcode/shared/i18n";
import { OFFICIAL_MOBILE_URL } from "@spcode/shared/remote";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsSheet } from "../src/components/SettingsSheet.js";
import type { PairingRecord } from "../src/lib/db";
import { useAppStore } from "../src/state/store";

const mocks = vi.hoisted(() => ({
  unpair: vi.fn<() => Promise<void>>(),
}));

vi.mock("../src/state/controller", () => ({
  probeRelayConfiguration: vi.fn(),
  updateRelayConfiguration: vi.fn(),
  unpair: mocks.unpair,
}));

const record: PairingRecord = {
  version: 2,
  desktopPk: "desktop-public-key",
  deviceId: "device-id",
  hosts: ["relay+wss://spcod-relay.hlt.cab"],
  deviceName: "测试手机",
  keyPair: { publicKey: "public", secretKey: "secret" },
  pairedAt: 1,
};

let appRoot: HTMLDivElement;
let mount: HTMLDivElement;
let root: Root | null;
let onClose: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  useAppStore.getState().reset();
  useAppStore.getState().setPairing(record);
  mocks.unpair.mockReset().mockResolvedValue(undefined);
  appRoot = document.createElement("div");
  appRoot.id = "root";
  mount = document.createElement("div");
  appRoot.append(mount);
  document.body.append(appRoot);
  root = createRoot(mount);
  onClose = vi.fn();
  await act(async () =>
    root!.render(
      createElement(I18nextProvider, { i18n }, createElement(SettingsSheet, { onClose: onClose as () => void })),
    ),
  );
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  appRoot.remove();
  useAppStore.getState().reset();
  vi.unstubAllGlobals();
});

async function click(testId: string): Promise<void> {
  const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  expect(element).not.toBeNull();
  await act(async () => element!.click());
}

describe("设置中的连接恢复", () => {
  it("重新配对需要确认，确认后清理本机记录并关闭设置", async () => {
    expect(document.querySelector('[data-testid="mobile-connection-recovery"]')).not.toBeNull();
    await click("mobile-repair");
    expect(document.querySelector('[data-testid="mobile-repair-confirm"]')).not.toBeNull();
    expect(mocks.unpair).not.toHaveBeenCalled();

    await click("mobile-repair-confirm");
    expect(mocks.unpair).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("取消重新配对不会清理记录", async () => {
    await click("mobile-repair");
    await click("mobile-repair-cancel");
    expect(document.querySelector('[data-testid="mobile-repair"]')).not.toBeNull();
    expect(mocks.unpair).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("提供官方配对页链接与无痕窗口恢复指引", () => {
    const link = document.querySelector<HTMLAnchorElement>('[data-testid="mobile-official-page"]');
    expect(link?.href).toBe(OFFICIAL_MOBILE_URL);
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toContain("noreferrer");
    expect(document.querySelector('[data-testid="mobile-connection-recovery"]')?.textContent).toContain("无痕窗口");
  });
});
