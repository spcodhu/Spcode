/** @vitest-environment jsdom */
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PairingRecord } from "../src/lib/db";
import { PairPage } from "../src/pages/PairPage";

const mocks = vi.hoisted(() => ({
  pairWithQr: vi.fn(),
  savePairing: vi.fn(),
  attachPairedRecord: vi.fn(),
  scanners: [] as {
    callback: (result: { data: string }) => void;
    start: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock("qr-scanner", () => ({
  default: class {
    constructor(_video: HTMLVideoElement, callback: (result: { data: string }) => void) {
      const scanner = { callback, start: vi.fn(async () => {}), destroy: vi.fn() };
      mocks.scanners.push(scanner);
      Object.assign(this, scanner);
    }
  },
}));
vi.mock("../src/lib/client", () => ({ pairWithQr: mocks.pairWithQr }));
vi.mock("../src/lib/db", () => ({ savePairing: mocks.savePairing }));
vi.mock("../src/state/controller", () => ({ attachPairedRecord: mocks.attachPairedRecord }));

const record: PairingRecord = {
  version: 1,
  desktopPk: "desktop",
  deviceId: "device",
  hosts: ["http://localhost"],
  deviceName: "最新设备名",
  keyPair: { publicKey: "public", secretKey: "secret" },
  pairedAt: 1,
};
let container: HTMLDivElement;
let root: Root | null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function render(): Promise<void> {
  await act(async () => root!.render(createElement(I18nextProvider, { i18n }, createElement(PairPage))));
}

function setInput(selector: string, value: string): void {
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  mocks.pairWithQr.mockReset();
  mocks.savePairing.mockReset().mockResolvedValue(undefined);
  mocks.attachPairedRecord.mockReset();
  mocks.scanners.length = 0;
  container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

describe("配对互斥与代次", () => {
  it("扫描器回调读取识别时的最新设备名", async () => {
    mocks.pairWithQr.mockResolvedValueOnce(record);
    await render();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="pair-scan"]')!.click());
    expect(mocks.scanners).toHaveLength(1);
    await act(async () => setInput('[data-testid="pair-device-name"]', "最新设备名"));
    await act(async () => mocks.scanners[0]!.callback({ data: "qr-from-camera" }));
    expect(mocks.pairWithQr).toHaveBeenCalledWith("qr-from-camera", "最新设备名");
    await vi.waitFor(() => expect(mocks.attachPairedRecord).toHaveBeenCalledWith(record));
    expect(mocks.savePairing).toHaveBeenCalledWith(record);
  });

  it("手动配对会停止扫描，忙碌中的迟到扫描结果不会重复配对", async () => {
    const pending = deferred<PairingRecord>();
    mocks.pairWithQr.mockReturnValueOnce(pending.promise);
    await render();
    await act(async () => setInput('[data-testid="pair-payload"]', "manual-qr"));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="pair-scan"]')!.click());
    const scanner = mocks.scanners[0]!;
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="pair-connect"]')!.click());
    expect(scanner.destroy).toHaveBeenCalled();
    expect(mocks.pairWithQr).toHaveBeenCalledWith("manual-qr", expect.any(String));
    await act(async () => scanner.callback({ data: "late-camera-qr" }));
    expect(mocks.pairWithQr).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.reject(new Error("配对失败"));
      await Promise.resolve();
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("配对失败");
  });

  it("卸载使在途配对失效，迟到结果不落盘也不启动客户端", async () => {
    const pending = deferred<PairingRecord>();
    mocks.pairWithQr.mockReturnValueOnce(pending.promise);
    await render();
    await act(async () => setInput('[data-testid="pair-payload"]', "manual-qr"));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="pair-connect"]')!.click());
    await act(async () => root!.unmount());
    root = null;
    await act(async () => {
      pending.resolve(record);
      await pending.promise;
      await Promise.resolve();
    });
    expect(mocks.savePairing).not.toHaveBeenCalled();
    expect(mocks.attachPairedRecord).not.toHaveBeenCalled();
  });
});
