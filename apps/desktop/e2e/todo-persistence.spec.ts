/**
 * Todo 进度跨应用重启恢复：注册表保存最近一次 TodoWrite 全量清单，
 * 冷启动打开会话时右侧工作区面板必须还原内容与完成状态。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

const SESSION_ID = "e2e-todo-persistence";
const TITLE = "E2E Todo 持久化";
const CWD = mkdtempSync(join(tmpdir(), "spcode-e2e-todo-cwd-"));
const TIMESTAMP = new Date(2026, 10, 2, 10, 0).getTime();
const TODOS = [
  { content: "已完成的阶段", status: "completed" },
  { content: "恢复中的任务", activeForm: "正在恢复任务", status: "in_progress" },
  { content: "等待开始的任务", status: "pending" },
];

function seed(home: string): void {
  const sessionsDir = join(home, "agent", "sessions", "-tmp-spcode-e2e-todo");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: SESSION_ID,
      timestamp: "2026-11-02T02:00:00.000Z",
      cwd: CWD,
    }),
    JSON.stringify({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: new Date(TIMESTAMP).toISOString(),
      message: { role: "user", timestamp: TIMESTAMP, content: [{ type: "text", text: "继续上次的任务" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: new Date(TIMESTAMP).toISOString(),
      message: { role: "assistant", timestamp: TIMESTAMP, content: [{ type: "text", text: "继续处理中" }] },
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
        todos: TODOS,
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
  );
}

async function assertRestored(window: Page) {
  await window.locator("div.group", { hasText: TITLE }).first().click();
  await expect(window.getByTestId("workspace-panel")).toBeVisible({ timeout: 15000 });
  const toggle = window.getByTestId("workspace-todo-toggle");
  await expect(toggle).toContainText("1/3");
  const tasks = window.getByTestId("work-task");
  await expect(tasks).toHaveCount(3);
  await expect(tasks.nth(0)).toContainText("已完成的阶段");
  await expect(tasks.nth(1)).toHaveAttribute("data-status", "in_progress");
  await expect(tasks.nth(1)).toContainText("正在恢复任务");
  await expect(tasks.nth(2)).toHaveAttribute("data-status", "pending");
  await expect(tasks.nth(2)).toContainText("等待开始的任务");
}

test("Todo 进度在应用重启后仍可恢复", async () => {
  const home = mkdtempSync(join(tmpdir(), "spcode-e2e-todo-home-"));
  let app = await launchApp({ spcodeHome: home, seed });
  let window = await app.firstWindow();
  await assertRestored(window);
  await app.close();

  app = await launchApp({ spcodeHome: home });
  window = await app.firstWindow();
  await assertRestored(window);
  await app.close();
});
