import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { launchApp } from "./helpers";

const SESSION_ID = "e2e-resizable-layout";
const TITLE = "E2E 三栏布局";
const CWD = mkdtempSync(join(tmpdir(), "spcode-e2e-layout-"));

function seed(home: string): void {
  const planPath = join(home, "plans", `${SESSION_ID}.md`);
  mkdirSync(join(home, "plans"), { recursive: true });
  writeFileSync(planPath, "# 可调三栏\n\n拖动两侧分隔条，中间内容保持可用。\n");
  const sessionsDir = join(home, "agent", "sessions", "layout");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "e2eresizablelayout",
      timestamp: "2026-02-01T00:00:00.000Z",
      cwd: CWD,
    }),
    JSON.stringify({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-02-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "三栏布局" }], timestamp: 1769904000000 },
    }),
    JSON.stringify({
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-02-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `[PLAN.md](plan:${planPath})` }],
        api: "anthropic-messages",
        provider: "test",
        model: "t",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1769904001000,
      },
    }),
  ];
  writeFileSync(sessionFile, `${lines.join("\n")}\n`);
  writeFileSync(
    join(home, "sessions.json"),
    JSON.stringify([
      {
        id: SESSION_ID,
        mode: "project",
        cwd: CWD,
        title: TITLE,
        model: null,
        thinkingLevel: "medium",
        sessionFile,
        planMode: true,
        planFile: planPath,
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
  );
}

async function openLayout(window: Page) {
  const row = window.locator("div.group", { hasText: TITLE }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();
  const link = window.getByTestId("plan-file-link");
  await expect(link).toBeVisible({ timeout: 15000 });
  await link.click();
  await expect(window.getByTestId("plan-panel")).toBeVisible();
}

async function drag(handle: Locator, deltaX: number, page: Page) {
  const box = await handle.boundingBox();
  if (!box) throw new Error("resize handle is not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + deltaX, box.y + 80, { steps: 8 });
  await page.mouse.up();
}

test("两条分隔条可拖动并持久化，窄栏主操作固定且按钮不换行", async () => {
  const spcodeHome = mkdtempSync(join(tmpdir(), "spcode-e2e-layout-home-"));
  const userDataDir = mkdtempSync(join(tmpdir(), "spcode-e2e-layout-data-"));
  let app = await launchApp({ spcodeHome, userDataDir, seed });
  let window = await app.firstWindow();
  await openLayout(window);

  await drag(window.getByTestId("sidebar-resize-handle"), 64, window);
  await expect.poll(async () => (await window.getByTestId("sidebar-panel").boundingBox())?.width).toBe(312);
  await drag(window.getByTestId("plan-resize-handle"), -40, window);
  await expect.poll(async () => (await window.getByTestId("plan-panel").boundingBox())?.width).toBe(600);

  await expect(window.getByTestId("composer-primary-actions")).toBeVisible();
  await expect(window.getByTestId("composer-model-menu")).toBeVisible();
  await expect(window.getByTestId("composer-send")).toBeVisible();
  const secondary = window.getByTestId("composer-secondary-actions");
  expect(await secondary.evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");
  for (const testId of [
    "md-mode-toggle",
    "composer-permission-mode",
    "composer-plan-mode",
    "composer-model-menu",
    "session-usage-chip",
    "plan-start-execution",
  ]) {
    expect(await window.getByTestId(testId).evaluate((el) => getComputedStyle(el).whiteSpace), testId).toBe("nowrap");
  }

  await window.getByTestId("sidebar-resize-handle").focus();
  await window.keyboard.press("ArrowRight");
  await expect.poll(async () => (await window.getByTestId("sidebar-panel").boundingBox())?.width).toBe(328);
  await app.close();

  app = await launchApp({ spcodeHome, userDataDir });
  window = await app.firstWindow();
  await openLayout(window);
  expect((await window.getByTestId("sidebar-panel").boundingBox())?.width).toBe(328);
  expect((await window.getByTestId("plan-panel").boundingBox())?.width).toBe(600);
  await app.close();
});
