/** @vitest-environment jsdom */
import type { UsageAggregate } from "@spcode/shared";
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dateKeyOf } from "../src/renderer/src/chart.js";
import { type DailyUsage, UsageTrends } from "../src/renderer/src/components/UsageTrends.js";

function aggregate(input: number): UsageAggregate {
  return {
    count: 1,
    input,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    costTotal: 0,
  };
}

function day(date: string, k3: number, deepseek: number): DailyUsage {
  return {
    date,
    total: aggregate(k3 + deepseek),
    byModel: { "p/k3": aggregate(k3), "p/deepseek": aggregate(deepseek) },
  };
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("用量趋势图", () => {
  it("显示友好刻度并为 7 天柱宽保留负空间", async () => {
    const today = dateKeyOf(new Date());
    const summary = [day(today, 120_000_000, 60_000_000)];
    await act(async () =>
      root.render(
        createElement(I18nextProvider, { i18n }, createElement(UsageTrends, { summary, colorIndexOf: new Map() })),
      ),
    );

    const chart = container.querySelector('[data-testid="usage-trend-chart"]')!;
    const labels = [...chart.querySelectorAll("text")].map((el) => el.textContent);
    expect(labels).toEqual(expect.arrayContaining(["5000万", "1亿", "1.5亿", "2亿"]));
    expect(labels).not.toContain("6667万");
    const bars = [...chart.querySelectorAll('[data-testid="usage-bar-seg"]')];
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) expect(bar.getAttribute("width")).toBe("56");
  });
});
