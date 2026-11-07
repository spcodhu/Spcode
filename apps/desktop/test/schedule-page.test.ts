/** @vitest-environment jsdom */
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchedulePage } from "../src/renderer/src/components/SchedulePage.js";

const store = vi.hoisted(() => ({ registrySessions: [] as any[] }));
vi.mock("../src/renderer/src/store", () => ({
  useStore: (selector: (state: typeof store) => unknown) => selector(store),
}));

function task(id: string, name: string) {
  return {
    id,
    name,
    prompt: `prompt for ${id}`,
    target: { kind: "chat" as const },
    frequency: "daily" as const,
    hour: 9,
    minute: 0,
    enabled: true,
    createdAt: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let root: Root;
const container = document;
let mount: HTMLDivElement;
let scheduleList: ReturnType<typeof vi.fn>;
let scheduleRunNow: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  store.registrySessions = [];
  scheduleList = vi.fn();
  scheduleRunNow = vi.fn();
  onClose = vi.fn();
  Object.defineProperty(window, "spcode", {
    configurable: true,
    value: {
      scheduleList,
      scheduleRunNow,
      scheduleUpdate: vi.fn(),
      scheduleDelete: vi.fn(),
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

async function render() {
  await act(async () =>
    root.render(createElement(I18nextProvider, { i18n }, createElement(SchedulePage, { onClose }))),
  );
}

function element<T extends HTMLElement = HTMLButtonElement>(id: string): T {
  return container.querySelector<T>(`[data-testid="${id}"]`)!;
}

async function click(id: string) {
  await act(async () => element(id).click());
}

describe("定时任务页", () => {
  it("列表显示下一次执行的相对时间和精确时间", async () => {
    const runAt = Date.now() + 3 * 3_600_000;
    scheduleList.mockResolvedValue([
      { ...task("next", "三小时后任务"), frequency: "once", runAt },
    ]);
    await render();
    expect(element("schedule-next-next").textContent).toMatch(/3\s*小时后/);
    expect(element("schedule-next-next").title).toContain(String(new Date(runAt).getFullYear()));
  });

  it("预置提示词支持添加和移除图片，图片也可独立作为任务内容", async () => {
    const scheduleCreate = vi.fn().mockResolvedValue(task("created", "图片任务"));
    const image = { name: "pixel.png", mimeType: "image/png", data: "aGVsbG8=" };
    const pickImages = vi.fn().mockResolvedValue([image]);
    Object.assign(window.spcode, { scheduleCreate, pickImages });
    scheduleList.mockResolvedValue([]);
    await render();
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("新建任务"))!
        .click(),
    );
    const name = document.querySelector<HTMLInputElement>('input[placeholder="如：每日晨报"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "图片任务");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("schedule-add-image");
    expect(document.querySelectorAll('[data-testid="schedule-image"]')).toHaveLength(1);
    await click("schedule-remove-image-0");
    expect(document.querySelectorAll('[data-testid="schedule-image"]')).toHaveLength(0);
    await click("schedule-add-image");
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("创建任务"))!
        .click(),
    );
    expect(scheduleCreate).toHaveBeenCalledWith(expect.objectContaining({ prompt: "", images: [image] }));
  });

  it("A/B 任务立即运行分别维护 pending，单个完成不会解除另一个任务", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    scheduleList.mockResolvedValue([task("a", "任务 A"), task("b", "任务 B")]);
    scheduleRunNow.mockImplementation((id: string) => (id === "a" ? first.promise : second.promise));
    await render();

    await click("schedule-run-a");
    await click("schedule-run-b");
    expect(element("schedule-run-a").disabled).toBe(true);
    expect(element("schedule-run-b").disabled).toBe(true);
    expect(element("schedule-run-a").textContent).toContain("运行中");
    expect(element("schedule-run-b").textContent).toContain("运行中");

    await act(async () => first.resolve("done"));
    expect(element("schedule-run-a").disabled).toBe(false);
    expect(element("schedule-run-b").disabled).toBe(true);
    expect(element("schedule-run-b").textContent).toContain("运行中");

    await act(async () => second.reject(new Error("B 执行失败")));
    expect(element("schedule-run-b").disabled).toBe(false);
    expect(element("schedule-run-error-b").textContent).toContain("B 执行失败");
    expect(element("schedule-run-error-b").textContent).toContain("立即运行失败");
  });

  it("首载失败显示错误和重试，不伪装成暂无任务；重试成功后才显示空态", async () => {
    const request = deferred<any>();
    scheduleList.mockReturnValueOnce(request.promise).mockResolvedValue([]);
    await render();
    expect(element("schedule-loading")).not.toBeNull();

    await act(async () => request.reject(new Error("任务服务不可用")));
    expect(element("schedule-load-error").textContent).toContain("任务服务不可用");
    expect(container.querySelector('[data-testid="schedule-empty"]')).toBeNull();

    await click("schedule-retry");
    expect(container.querySelector('[data-testid="schedule-load-error"]')).toBeNull();
    expect(element("schedule-empty").textContent).toContain("还没有定时任务");
    expect(scheduleList).toHaveBeenCalledTimes(2);
  });
});
