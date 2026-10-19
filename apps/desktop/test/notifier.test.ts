/**
 * Notifier 单测（评审 R3-F4）：聚焦抑制、长任务阈值、Dock 徽标计数。
 * electron 用 vi.mock 替代（vitest 里没有真 Notification/Dock）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("Notifier", () => {
  beforeEach(() => {
    shown.length = 0;
    badgeValues.length = 0;
  });

  it("窗口聚焦时不发通知；未聚焦时发；徽标随待办增减", () => {
    let focused = false;
    const n = new Notifier({ isEnabled: () => true, getWindow: () => ({ isFocused: () => focused }) as never });

    n.notifyApprovalNeeded("permission", "r1", "bash 等待批准");
    expect(shown).toHaveLength(1);
    expect(badgeValues.at(-1)).toBe("1");

    focused = true;
    n.notifyApprovalNeeded("question", "r2", "提问");
    expect(shown).toHaveLength(1); // 聚焦时抑制
    expect(badgeValues.at(-1)).toBe("2");

    n.resolveApproval("r1");
    n.resolveApproval("r2");
    expect(badgeValues.at(-1)).toBe("");
  });

  it("通知开关关闭时：不发通知但徽标仍计数", () => {
    const n = new Notifier({ isEnabled: () => false, getWindow: () => null });
    n.notifyApprovalNeeded("permission", "r1", "t");
    expect(shown).toHaveLength(0);
    expect(badgeValues.at(-1)).toBe("1");
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
});
