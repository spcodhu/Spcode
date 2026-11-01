import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

const SESSION_ID = "e2e-message-actions";
const TITLE = "消息操作";
const CWD = mkdtempSync(join(tmpdir(), "spcode-e2e-actions-"));
const TIMESTAMP = new Date(2026, 10, 1, 22, 18).getTime();

function seed(home: string): void {
  const sessionsDir = join(home, "agent", "sessions", "-tmp-spcode-e2e-actions");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "e2emessageactions",
      timestamp: "2026-11-01T14:18:00.000Z",
      cwd: CWD,
    }),
    JSON.stringify({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: new Date(TIMESTAMP).toISOString(),
      message: { role: "user", timestamp: TIMESTAMP, content: [{ type: "text", text: "需要修改的问题" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: new Date(TIMESTAMP).toISOString(),
      message: { role: "assistant", timestamp: TIMESTAMP, content: [{ type: "text", text: "可见回答" }] },
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
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
  );
}

test("消息悬浮显示时间，编辑只回填输入框且不改变历史", async () => {
  const app = await launchApp({ seed });
  const window = await app.firstWindow();
  await window.locator("div.group", { hasText: TITLE }).first().click();

  const message = window.getByTestId("user-message");
  const bubble = message.getByText("需要修改的问题", { exact: true });
  await expect(bubble).toBeVisible({ timeout: 15000 });
  await bubble.hover();
  await expect(message.getByTestId("message-time")).toHaveText("2026-11-01 22:18");
  await expect(message.getByTestId("message-copy")).toBeVisible();

  await message.getByTestId("message-edit").click();
  await expect(window.getByTestId("composer-input")).toHaveValue("需要修改的问题");
  await expect(message.getByText("需要修改的问题", { exact: true })).toHaveCount(1);
  await expect(window.getByText("可见回答", { exact: true })).toHaveCount(1);
  await app.close();
});
