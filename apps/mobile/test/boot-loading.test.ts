/** 首屏装载门禁：冷启动/新配对先展示加载动画，连接 + 语言 + 首个会话列表齐备后一次性放行；未配对直接进配对页。 */
import type { SessionMeta } from "@spcode/shared";
import { i18n, setLocale } from "@spcode/shared/i18n";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import type { RemoteClientCallbacks } from "../src/lib/client";
import type { PairingRecord } from "../src/lib/db";
import { mobileText } from "../src/lib/i18n";
import { attachPairedRecord, boot, revealBootStatus, unpair } from "../src/state/controller";
import { useAppStore } from "../src/state/store";

const mocks = vi.hoisted(() => ({
  callbacks: [] as RemoteClientCallbacks[],
  loadPairing: vi.fn<() => Promise<PairingRecord | null>>(),
  command: vi.fn<(cmd: { type: string }) => Promise<unknown>>(),
}));

vi.mock("../src/lib/db", () => ({
  loadPairing: mocks.loadPairing,
  savePairing: vi.fn(async () => {}),
  clearPairing: vi.fn(async () => {}),
}));
vi.mock("../src/lib/client", () => ({
  RemoteClient: class {
    command = mocks.command;
    constructor(
      _record: PairingRecord,
      private cb: RemoteClientCallbacks,
    ) {
      mocks.callbacks.push(cb);
    }
    start() {
      this.cb.onState("connecting");
    }
    stop() {}
  },
}));
// SSR 读取当前快照而非初始快照，便于按控制器事件断言渲染结果（与 i18n.test 同款）。
vi.mock("../src/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state/store")>();
  const hook = Object.assign(
    (selector: (state: ReturnType<typeof actual.useAppStore.getState>) => unknown) =>
      selector(actual.useAppStore.getState()),
    actual.useAppStore,
  );
  return { ...actual, useAppStore: hook };
});

const record: PairingRecord = {
  version: 2,
  desktopPk: "desktop",
  deviceId: "device",
  hosts: ["http://localhost"],
  deviceName: "test",
  keyPair: { publicKey: "public", secretKey: "secret" },
  pairedAt: 1,
};
const session: SessionMeta = {
  id: "s1",
  mode: "chat",
  cwd: "",
  title: "现有会话",
  model: null,
  thinkingLevel: "medium",
  createdAt: 1,
  updatedAt: 2,
};

function render(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element));
}
function callback(): RemoteClientCallbacks {
  return mocks.callbacks[mocks.callbacks.length - 1]!;
}
function hello(locale = "zh-CN"): void {
  callback().onEvent({ type: "remote.hello", vapidPublicKey: "", locale });
}
/** 走完已配对冷启动的全部环节：连接就绪 + 首个列表 + 语言同步。 */
async function settlePairedBoot(): Promise<void> {
  await boot();
  callback().onState("ready");
  await vi.waitFor(() => expect(useAppStore.getState().sessionsLoaded).toBe(true));
  hello();
}

let storage: Map<string, string>;
beforeEach(() => {
  useAppStore.getState().reset();
  mocks.callbacks.length = 0;
  mocks.command.mockReset().mockImplementation(async (cmd) => {
    if (cmd.type === "session.list") return { sessions: [session] };
    return { tasks: [] };
  });
  mocks.loadPairing.mockReset().mockResolvedValue(record);
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("document", { documentElement: { lang: "", dir: "" }, title: "" });
  setLocale("zh-CN");
});
afterEach(async () => {
  await unpair();
  vi.unstubAllGlobals();
});

describe("首屏门禁：控制器放行时机", () => {
  it("已配对冷启动：连接就绪但语言/列表未到齐前不放行", async () => {
    await boot();
    expect(useAppStore.getState().bootSettled).toBe(false);
    callback().onState("ready");
    await vi.waitFor(() => expect(useAppStore.getState().sessionsLoaded).toBe(true));
    // 列表已到、语言未到：仍不放行
    expect(useAppStore.getState().bootSettled).toBe(false);
    hello();
    expect(useAppStore.getState().bootSettled).toBe(true);
  });

  it("语言先于列表到达时，等到首个列表才放行", async () => {
    await boot();
    callback().onState("ready");
    hello();
    expect(useAppStore.getState().localeReady).toBe(true);
    await vi.waitFor(() => expect(useAppStore.getState().bootSettled).toBe(true));
    expect(useAppStore.getState().sessionsLoaded).toBe(true);
  });

  it("空会话列表也算首个列表，正常放行", async () => {
    mocks.command.mockImplementation(async (cmd) => {
      if (cmd.type === "session.list") return { sessions: [] };
      return { tasks: [] };
    });
    await settlePairedBoot();
    expect(useAppStore.getState().bootSettled).toBe(true);
    expect(useAppStore.getState().sessionsLoaded).toBe(true);
    expect(Object.keys(useAppStore.getState().sessions)).toHaveLength(0);
  });

  it("未配对冷启动直接进配对页并放行", async () => {
    mocks.loadPairing.mockResolvedValue(null);
    await boot();
    expect(useAppStore.getState().route).toEqual({ name: "pair" });
    expect(useAppStore.getState().bootSettled).toBe(true);
  });

  it.each(["unpaired", "incompatible", "grant_expired"] as const)("终态 %s 放行以露出横幅与操作入口", async (state) => {
    await boot();
    expect(useAppStore.getState().bootSettled).toBe(false);
    callback().onState(state);
    expect(useAppStore.getState().bootSettled).toBe(true);
  });

  it("新配对重新进入门禁，待新连接齐备后再放行", async () => {
    await settlePairedBoot();
    expect(useAppStore.getState().bootSettled).toBe(true);
    attachPairedRecord(record);
    expect(useAppStore.getState().bootSettled).toBe(false);
    expect(useAppStore.getState().sessionsLoaded).toBe(false);
    callback().onState("ready");
    await vi.waitFor(() => expect(useAppStore.getState().sessionsLoaded).toBe(true));
    hello();
    expect(useAppStore.getState().bootSettled).toBe(true);
  });

  it("revealBootStatus 兜底强制放行（桌面离线等长时间未就绪）", async () => {
    await boot();
    expect(useAppStore.getState().bootSettled).toBe(false);
    revealBootStatus();
    expect(useAppStore.getState().bootSettled).toBe(true);
  });
});

describe("首屏门禁：渲染", () => {
  it("冷启动展示加载动画，隐藏连接横幅与会话内容", async () => {
    await boot();
    const html = render(createElement(App));
    expect(html).toContain('data-testid="boot-loader"');
    expect(html).toContain('hidden="" data-testid="session-content"');
    expect(html).not.toContain('data-testid="locale-pending"');
    expect(html).not.toContain(mobileText("connection.connecting"));
  });

  it("未配对直接渲染配对页，无加载动画", async () => {
    mocks.loadPairing.mockResolvedValue(null);
    await boot();
    const html = render(createElement(App));
    expect(html).toContain(mobileText("pair.title"));
    expect(html).not.toContain('data-testid="boot-loader"');
  });

  it("全部环节就绪后一次性放出会话列表，加载动画消失", async () => {
    await settlePairedBoot();
    const html = render(createElement(App));
    expect(html).not.toContain('data-testid="boot-loader"');
    expect(html).not.toContain('hidden="" data-testid="session-content"');
    expect(html).toContain(session.title);
  });

  it("放行后断线重连展示横幅而非加载动画（稳态不回到门禁）", async () => {
    await settlePairedBoot();
    callback().onState("reconnecting");
    const html = render(createElement(App));
    expect(html).not.toContain('data-testid="boot-loader"');
    expect(html).toContain(mobileText("connection.reconnecting"));
  });
});
