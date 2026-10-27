/** @vitest-environment jsdom */
import type { PermissionRequest } from "@spcode/shared";
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionInline } from "../src/renderer/src/components/PermissionCard.js";

const state = vi.hoisted(() => ({
  pending: [] as PermissionRequest[],
  reply: vi.fn(),
}));

vi.mock("../src/renderer/src/store", () => ({
  useStore: (select: (s: unknown) => unknown) =>
    select({
      pendingPermissions: state.pending,
      replyPermission: state.reply,
      settings: null,
      saveSettings: vi.fn(),
    }),
}));

function request(id: string, sessionId: string, command: string): PermissionRequest {
  return { requestId: id, sessionId, toolName: "bash", args: { command }, risk: "write" };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.pending = [
    request("s1-first", "s1", "git push origin main"),
    request("s2-only", "s2", "pnpm test"),
    request("s1-second", "s1", "pnpm build"),
  ];
  state.reply.mockReset();
  setLocale("zh-CN");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  setLocale("zh-CN");
});

async function render(sessionId: string) {
  await act(async () =>
    root.render(createElement(I18nextProvider, { i18n }, createElement(PermissionInline, { sessionId }))),
  );
}

describe("会话内嵌权限卡", () => {
  it("只展示所属会话与当前会话队列，不使用全局 alertdialog", async () => {
    await render("s1");
    const inline = container.querySelector<HTMLElement>('[data-testid="permission-inline"]')!;
    expect(inline.dataset.sessionId).toBe("s1");
    expect(container.textContent).toContain("git push origin main");
    expect(container.textContent).not.toContain("pnpm test");
    expect(container.textContent).toContain("还有 1 个待确认");
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();

    await render("s2");
    expect(container.textContent).toContain("pnpm test");
    expect(container.textContent).not.toContain("git push origin main");
    expect(container.textContent).not.toContain("还有");
  });

  it("批准或拒绝只回复当前显示的 requestId", async () => {
    await render("s1");
    container.querySelector<HTMLButtonElement>('[data-testid="permission-allow"]')!.click();
    expect(state.reply).toHaveBeenLastCalledWith("s1-first", true);

    await render("s2");
    container.querySelector<HTMLButtonElement>('[data-testid="permission-deny"]')!.click();
    expect(state.reply).toHaveBeenLastCalledWith("s2-only", false);
  });
});
