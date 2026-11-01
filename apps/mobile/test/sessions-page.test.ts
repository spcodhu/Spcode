/** @vitest-environment jsdom */
import type { SessionMeta } from "@spcode/shared";
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectProjectOptions } from "../src/components/ProjectPicker";
import { SessionsPage } from "../src/pages/SessionsPage";
import { useAppStore } from "../src/state/store";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  refreshModels: vi.fn(),
  removeSession: vi.fn(),
  renameSession: vi.fn(),
  unpair: vi.fn(),
}));
vi.mock("../src/state/controller", () => ({
  createSession: mocks.createSession,
  refreshModels: mocks.refreshModels,
  removeSession: mocks.removeSession,
  renameSession: mocks.renameSession,
  unpair: mocks.unpair,
}));

let root: Root;
let container: HTMLDivElement;

function meta(id: string, mode: "chat" | "project", cwd: string, updatedAt: number): SessionMeta {
  return {
    id,
    mode,
    cwd,
    title: id,
    model: null,
    thinkingLevel: "medium",
    createdAt: 1,
    updatedAt,
  };
}

async function renderPage() {
  await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(SessionsPage))));
}

async function openNewTask() {
  await act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("新任务"))!
      .click();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  useAppStore.getState().reset();
  useAppStore.getState().setConn("ready");
  mocks.createSession.mockReset().mockResolvedValue("new-session");
  mocks.refreshModels.mockReset().mockResolvedValue([]);
  useAppStore.getState().setModels(
    [
      {
        provider: "p",
        modelId: "custom",
        displayName: "Custom Model",
        contextWindow: 1000,
        maxTokens: 100,
        thinkingLevels: [],
        available: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        priceKnown: false,
      },
    ],
    { provider: "p", modelId: "custom" },
  );
  mocks.removeSession.mockReset();
  mocks.renameSession.mockReset();
  mocks.unpair.mockReset();
  container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("手机新建会话流程", () => {
  it("聊天无需提示词，直接创建空会话", async () => {
    await renderPage();
    await openNewTask();
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.querySelector('[data-testid="project-options"]')).toBeNull();

    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="new-session-submit"]')!.click());
    expect(mocks.createSession).toHaveBeenCalledWith({ mode: "chat", cwd: undefined });
  });

  it("项目只能从 PC 已有空间选择，cwd 去重且不需要手输", async () => {
    useAppStore.getState().setSessions([
      meta("p1", "project", "/code/alpha", 2),
      meta("p2", "project", "/code/alpha", 4),
      meta("p3", "project", "/code/beta", 3),
      meta("c1", "chat", "", 9),
    ]);
    await renderPage();
    await openNewTask();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="new-session-mode-project"]')!.click());

    const options = [...document.querySelectorAll<HTMLElement>('[data-testid="project-option"]')];
    expect(options.map((option) => option.dataset.cwd)).toEqual(["/code/alpha", "/code/beta"]);
    expect(document.querySelector('input[aria-label*="项目目录"]')).toBeNull();
    await act(async () => options[1]!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="new-session-submit"]')!.click());
    expect(mocks.createSession).toHaveBeenCalledWith({ mode: "project", cwd: "/code/beta" });
  });

  it("新建会话可选择 PC 已配置模型", async () => {
    await renderPage();
    await openNewTask();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="model-field"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-model="p/custom"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="new-session-submit"]')!.click());
    expect(mocks.createSession).toHaveBeenCalledWith({
      mode: "chat",
      cwd: undefined,
      model: { provider: "p", modelId: "custom" },
    });
  });

  it("没有 PC 项目时展示空态并禁止创建项目会话", async () => {
    await renderPage();
    await openNewTask();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="new-session-mode-project"]')!.click());
    expect(document.querySelector('[data-testid="project-options-empty"]')?.textContent).toContain("还没有项目空间");
    expect(document.querySelector<HTMLButtonElement>('[data-testid="new-session-submit"]')!.disabled).toBe(true);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});

describe("项目候选提取", () => {
  it("同目录保留最近更新时间，聊天与空目录被排除", () => {
    const options = collectProjectOptions([
      meta("old", "project", "/code/a", 1),
      meta("new", "project", "/code/a", 10),
      meta("b", "project", "/code/b", 5),
      meta("chat", "chat", "", 20),
    ]);
    expect(options.map((option) => [option.cwd, option.updatedAt])).toEqual([
      ["/code/a", 10],
      ["/code/b", 5],
    ]);
  });
});
