/**
 * Notifier 单测（评审 R3-F4）：聚焦抑制、长任务阈值、Dock 徽标计数。
 * electron 用 vi.mock 替代（vitest 里没有真 Notification/Dock）。
 */
import { setLocale } from "@spcode/shared/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shown: { title: string; body: string }[] = [];
const badgeValues: string[] = [];

vi.mock("electron", () => ({
  Notification: class {
    static isSupported() {
      return true;
    }
    constructor(opts: { title: string; body: string }) {
      shown.push(opts);
    }
    on(): void {}
    show(): void {}
  },
  app: { dock: { setBadge: (v: string) => badgeValues.push(v) } },
  BrowserWindow: class {},
}));

import { Notifier } from "../src/main/notifier.js";

/**
 * Dock 徽标是 macOS 专有能力（app.dock 为 undefined，产品代码里按 platform 提前 return），
 * 因此徽标断言只能在 darwin 上生效；通知（Notification）在所有平台都要断言。
 */
const expectBadge = (value: string) => {
  if (process.platform !== "darwin") return;
  expect(badgeValues.at(-1)).toBe(value);
};

describe("Notifier", () => {
  beforeEach(() => {
    setLocale("zh-CN");
    shown.length = 0;
    badgeValues.length = 0;
  });
  afterEach(() => setLocale("zh-CN"));

  it("uses the send-time locale, including errors recorded before a switch", () => {
    const n = new Notifier({ isEnabled: () => true, getWindow: () => null });
    n.notifyApprovalNeeded("permission", "r-zh", "User content <原文>");
    expect(shown.at(-1)).toEqual({ title: "需要审批", body: "User content <原文>" });
    n.noteSessionEvent("s", {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "402 Insufficient Balance" },
    });
    setLocale("en");
    n.notifyApprovalNeeded("question", "r-en", "User content <原文>");
    expect(shown.at(-1)).toEqual({ title: "Agent has a question", body: "User content <原文>" });
    n.noteSessionEvent("s", { type: "agent_settled" });
    expect(shown.at(-1)).toEqual({
      title: "Task interrupted: model quota exhausted",
      body: "Click for details and suggested actions",
    });
    setLocale("zh-CN");
    n.notifyApprovalNeeded("question", "r-zh-again", "原文");
    expect(shown.at(-1)?.title).toBe("Agent 在提问");
  });

  it("窗口聚焦时不发通知；未聚焦时发；徽标随待办增减", () => {
    let focused = false;
    const n = new Notifier({ isEnabled: () => true, getWindow: () => ({ isFocused: () => focused }) as never });

    n.notifyApprovalNeeded("permission", "r1", "bash 等待批准");
    expect(shown).toHaveLength(1);
    expectBadge("1");

    focused = true;
    n.notifyApprovalNeeded("question", "r2", "提问");
    expect(shown).toHaveLength(1); // 聚焦时抑制
    expectBadge("2");

    n.resolveApproval("r1");
    n.resolveApproval("r2");
    expectBadge("");
  });

  it("通知开关关闭时：不发通知但徽标仍计数", () => {
    const n = new Notifier({ isEnabled: () => false, getWindow: () => null });
    n.notifyApprovalNeeded("permission", "r1", "t");
    expect(shown).toHaveLength(0);
    expectBadge("1");
  });

  it("长任务完成才通知（<15s 的短回合不打扰）", () => {
    vi.useFakeTimers();
    try {
      const n = new Notifier({ isEnabled: () => true, getWindow: () => null });
      n.noteSessionEvent("s1", { type: "agent_start" });
      n.noteSessionEvent("s1", { type: "agent_settled" }); // 瞬间完成
      expect(shown).toHaveLength(0);

      n.noteSessionEvent("s2", { type: "agent_start" });
      vi.advanceTimersByTime(20_000);
      n.noteSessionEvent("s2", { type: "agent_settled" });
      expect(shown).toHaveLength(1);
      expect(shown[0]?.title).toBe("任务完成");
    } finally {
      vi.useRealTimers();
    }
  });

  it("额度不足导致回合失败：短回合也要通知，标题分类为额度", () => {
    vi.useFakeTimers();
    try {
      const n = new Notifier({ isEnabled: () => true, getWindow: () => null });
      n.noteSessionEvent("s1", { type: "agent_start" });
      n.noteSessionEvent("s1", {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "402 Insufficient Balance" },
      });
      n.noteSessionEvent("s1", { type: "agent_settled" });
      expect(shown).toHaveLength(1);
      expect(shown[0]?.title).toContain("额度");
    } finally {
      vi.useRealTimers();
    }
  });

  it("错误被重试救回（后续 stop 回合）不发失败通知", () => {
    const n = new Notifier({ isEnabled: () => true, getWindow: () => null });
    n.noteSessionEvent("s1", { type: "agent_start" });
    n.noteSessionEvent("s1", {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "429 rate limit" },
    });
    n.noteSessionEvent("s1", { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
    n.noteSessionEvent("s1", { type: "agent_settled" });
    expect(shown).toHaveLength(0);
  });
});
