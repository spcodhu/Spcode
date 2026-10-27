/** @vitest-environment jsdom */
import type { SessionRegistryEntry } from "@spcode/shared";
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRow } from "../src/renderer/src/components/Sidebar.js";

const entry: SessionRegistryEntry = {
  id: "s1",
  mode: "project",
  cwd: "/tmp/project",
  title: "一个会被时间挤压的会话标题",
  model: null,
  thinkingLevel: "off",
  createdAt: 1,
  updatedAt: Date.now() - 60_000,
  sessionFile: "/tmp/session.jsonl",
};

let root: Root;
let container: HTMLDivElement;
let onOpen: ReturnType<typeof vi.fn>;
let onDelete: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  onOpen = vi.fn();
  onDelete = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(active = true, permissionWaiting = false) {
  await act(async () =>
    root.render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(SessionRow, {
          r: entry,
          active,
          running: false,
          waiting: false,
          permissionWaiting,
          nested: true,
          menuItems: [],
          onOpen,
          onDelete,
        }),
      ),
    ),
  );
}

describe("侧栏会话行", () => {
  it("当前态明确，时间与操作共用固定区域且支持键盘焦点", async () => {
    await render();
    const row = container.firstElementChild as HTMLElement;
    expect(row.getAttribute("aria-current")).toBe("page");
    expect(row.className).toContain("bg-accent-soft");
    const trailing = row.querySelector(".relative.h-6.w-16")!;
    expect(trailing.querySelector(".group-hover\\:hidden")).toBeNull();
    const actions = trailing.querySelector(".pointer-events-none.absolute.inset-0")!;
    expect(actions.className).toContain("group-focus-within:opacity-100");
    const remove = row.querySelector('[data-testid="sidebar-delete-session"]')!;
    expect(remove.className).not.toContain("hidden");

    await act(async () => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("权限等待标记在会话标题 trailing 区可见", async () => {
    await render(false, true);
    const badge = container.querySelector('[data-testid="sidebar-permission-waiting"]')!;
    expect(badge.getAttribute("aria-label")).toBe("有权限请求等待批准");
  });

  it("删除只执行删除，不冒泡成打开会话", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    await render(false);
    const row = container.firstElementChild as HTMLElement;
    expect(row.getAttribute("aria-current")).toBeNull();
    const remove = row.querySelector<HTMLButtonElement>('[data-testid="sidebar-delete-session"]')!;
    await act(async () => remove.click());
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
