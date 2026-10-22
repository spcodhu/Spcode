import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

/**
 * 用量图表回归：预置一份 3 模型（其中一个只占 0.2%）的用量账本，
 * 断言饼图三段都有颜色、柱状图按模型堆叠、标题区总量为区间内真实数字。
 *
 * 这正是曾经的 bug：0.2% 的模型弧长算成 0，饼图永远只显示两种颜色。
 */

/** 本地时区 YYYY-MM-DD（与 UsageLedger.dateOf 同口径） */
function dateKey(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

interface SeedRow {
  modelId: string;
  /** 三条记录的输入 token（合计即该模型总量） */
  input: [number, number, number];
}

const ROWS: SeedRow[] = [
  // 总量 2.02 亿：75%
  { modelId: "k3", input: [80_000_000, 70_000_000, 52_000_000] },
  // 总量 6780 万：25%
  { modelId: "deepseek-flash", input: [30_000_000, 20_000_000, 17_800_000] },
  // 总量 57.2 万：约 0.2%——旧实现画不出来
  { modelId: "mimo-v2.6-pro", input: [200_000, 200_000, 172_000] },
];

const TOTAL = ROWS.reduce((n, r) => n + r.input.reduce((a, b) => a + b, 0), 0);

/** 设置 → 用量页（图表在此页） */
async function openUsage(window: Awaited<ReturnType<Awaited<ReturnType<typeof launchApp>>["firstWindow"]>>) {
  await window.getByTitle("设置", { exact: true }).click();
  await window.getByRole("button", { name: "用量", exact: true }).click();
  await expect(window.getByTestId("usage-trend-chart")).toBeVisible({ timeout: 15000 });
}

function seed(home: string): void {
  const dir = join(home, "usage");
  mkdirSync(dir, { recursive: true });
  const dates = [dateKey(0), dateKey(-1), dateKey(-2)];
  dates.forEach((date, dayIdx) => {
    const lines = ROWS.map((row, modelIdx) => {
      const input = row.input[dayIdx] ?? 0;
      return JSON.stringify({
        date,
        sessionId: `e2e-usage-${modelIdx}`,
        model: { provider: "e2e", modelId: row.modelId },
        timestamp: Date.now() - dayIdx * 86_400_000,
        input,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costInput: 0,
        costOutput: 0,
        costCacheRead: 0,
        costCacheWrite: 0,
        costTotal: 0,
      });
    });
    writeFileSync(join(dir, `${date}.jsonl`), `${lines.join("\n")}\n`, "utf-8");
  });
}

test("用量图表：饼图三种颜色 + 堆叠柱状图 + 区间总量", async () => {
  const app = await launchApp({ seed });
  const window = await app.firstWindow();

  await openUsage(window);

  // 饼图：三个模型都有弧段，且颜色互不相同（0.2% 的模型不再隐身）
  const arcs = window.getByTestId("usage-donut-arc");
  await expect(arcs).toHaveCount(3, { timeout: 15000 });
  const strokes = await arcs.evaluateAll((els) => els.map((el) => el.getAttribute("stroke") ?? ""));
  expect(new Set(strokes).size).toBe(3);
  for (const s of strokes) expect(s).not.toBe("");

  // 图例：极小占比显示 <1% 而不是 0%
  await expect(window.getByTestId("usage-legend-color").first()).toBeVisible();
  await expect(window.getByText("<1%")).toBeVisible();

  // 标题区总量 = 区间内真实总量（2.7亿），并给出精确数字说明
  const total = window.getByTestId("usage-trend-total");
  await expect(total).toBeVisible();
  await expect(total).toHaveText("2.7亿");
  expect(await total.getAttribute("title")).toBe(`${TOTAL.toLocaleString("en-US")} tokens`);

  // 堆叠柱：每天一支柱、柱内按模型分段（3 模型 × 3 天 = 9 段），颜色 ≥3 种
  const segs = window.getByTestId("usage-bar-seg");
  await expect(segs.first()).toBeVisible();
  expect(await segs.count()).toBe(9);
  const fills = await segs.evaluateAll((els) => els.map((el) => el.getAttribute("fill") ?? ""));
  expect(new Set(fills).size).toBe(3);

  // 切区间后图表仍在且总量按新区间重算（30 天窗口含这 3 天，总量不变）
  await window.getByRole("button", { name: "最近 30 天" }).click();
  await expect(window.getByTestId("usage-trend-chart")).toBeVisible();
  await expect(window.getByTestId("usage-trend-total")).toHaveText("2.7亿");

  await app.close();
});

test("用量图表：悬浮出明细、点击锁定高亮（环形图/柱状图/热点图）", async () => {
  const app = await launchApp({ seed });
  const window = await app.firstWindow();

  await openUsage(window);

  const donutTip = window.getByTestId("usage-donut-card").getByTestId("chart-tip");
  const trendTip = window.getByTestId("usage-trend").getByTestId("chart-tip");
  const heatTip = window.getByTestId("usage-heatmap").getByTestId("chart-tip");
  const arcs = window.getByTestId("usage-donut-arc");
  await expect(arcs).toHaveCount(3, { timeout: 15000 });

  // 环形图：悬浮图例行 → 对应弧段加粗、其余变暗（图例行不弹卡片，避免盖住相邻行）
  const legendRow = window.getByTestId("usage-legend-row").first();
  await legendRow.hover();
  await expect(donutTip).toHaveCount(0);
  const widths = await arcs.evaluateAll((els) => els.map((el) => Number(el.getAttribute("stroke-width"))));
  expect(widths.filter((w) => w === 30).length).toBe(1);

  // 扇区本身悬浮出明细卡片（指到环的上沿）：点环心外的描边带
  const ring = await arcs.first().boundingBox();
  if (!ring) throw new Error("饼图没有渲染出弧段");
  await window.mouse.move(ring.x + ring.width / 2, ring.y + 13);
  await expect(donutTip).toBeVisible();
  await expect(donutTip).toContainText("tokens");
  await expect(donutTip).toContainText("次请求");

  // 点击扇区锁定：鼠标移开后提示仍在（data-pinned=true）
  await window.mouse.down();
  await window.mouse.up();
  await window.mouse.move(2, 2);
  await expect(donutTip).toBeVisible();
  await expect(donutTip).toHaveAttribute("data-pinned", "true");
  const pinnedWidths = await arcs.evaluateAll((els) => els.map((el) => Number(el.getAttribute("stroke-width"))));
  expect(pinnedWidths.filter((w) => w === 30).length).toBe(1);

  // 柱状图：悬浮到某天上 → 当日明细（日期），点击锁定后出现高亮列
  const hit = window.getByTestId("usage-bar-hit").first();
  await hit.hover();
  await expect(trendTip).toContainText(/\d{4}[/-]\d{2}[/-]\d{2}/);
  await hit.click();
  await expect(window.getByTestId("usage-bar-cursor")).toBeVisible();
  await window.mouse.move(2, 2);
  await expect(trendTip).toHaveAttribute("data-pinned", "true");

  // 热点图：悬浮今天 → 提示卡片显示当天 token；点击锁定后格子有高亮环
  const cell = window.locator(`[data-testid="usage-heat-cell"][data-date="${dateKey(0)}"]`);
  await cell.hover();
  await expect(heatTip).toContainText("tokens");
  await cell.click();
  await expect(cell).toHaveClass(/ring-2/);

  await app.close();
});

test("用量图表：该区间没有消耗时也保留饼图与指标卡（结构不动）", async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await openUsage(window);

  // 空区间也要有：环形图卡片（空环）、四个指标卡、图例区的占位说明
  await expect(window.getByTestId("usage-donut-card")).toBeVisible();
  await expect(window.getByTestId("usage-donut-arc")).toHaveCount(0);
  await expect(window.getByText("该区间还没有用量记录")).toBeVisible();
  for (const label of ["总 Token", "请求次数", "输入 Token", "输出 Token"]) {
    await expect(window.getByText(label, { exact: true })).toBeVisible();
  }

  // 切到「今日」：结构照旧，不被整块换成一句空态文案
  await window.getByRole("button", { name: "今日", exact: true }).click();
  await expect(window.getByTestId("usage-overview")).toBeVisible();
  await expect(window.getByText("总 Token", { exact: true })).toBeVisible();
  await expect(window.getByTestId("usage-trend")).toBeVisible();
  await expect(window.getByTestId("usage-heatmap")).toBeVisible();

  await app.close();
});
