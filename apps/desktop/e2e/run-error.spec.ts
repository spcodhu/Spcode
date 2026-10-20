import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

/**
 * 运行被错误中断的错误卡回归：
 * 原始错误必须**直接显示**在卡片里（旧实现藏在「详情」按钮后面，用户还得多点一次）。
 *
 * 素材走真实会话文件回放：assistant 消息 stopReason=error + errorMessage，
 * 这正是 pi 在额度/鉴权类不可重试错误上落盘的形状（content 为空）。
 */

const PROJECT_CWD = "/tmp/spcode-e2e-run-error";
const SESSION_ID = "e2e-run-error-1";
const RAW_ERROR = "Error: EPERM: operation not permitted, open '/Users/x/.spcode/settings.json'";

function seed(home: string): void {
  mkdirSync(PROJECT_CWD, { recursive: true });
  const sessionsDir = join(home, "agent", "sessions", "-tmp-spcode-e2e-run-error");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "2026-02-02T00-00-00-000Z_e2erunerror1.jsonl");

  let n = 0;
  let parentId: string | null = null;
  const entry = (message: unknown) => {
    const id = `bbbb${String(++n).padStart(4, "0")}`;
    const line = JSON.stringify({
      type: "message",
      id,
      parentId,
      timestamp: "2026-02-02T00:00:00.000Z",
      message,
    });
    parentId = id;
    return line;
  };

  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "e2erunerror1",
      timestamp: "2026-02-02T00:00:00.000Z",
      cwd: PROJECT_CWD,
    }),
    entry({ role: "user", content: [{ type: "text", text: "帮我看下这个文件" }], timestamp: 1769980800000 }),
    entry({
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "test",
      model: "t",
      usage: {
        input: 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: RAW_ERROR,
      timestamp: 1769980800000,
    }),
  ];
  writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf-8");

  writeFileSync(
    join(home, "sessions.json"),
    JSON.stringify(
      [
        {
          id: SESSION_ID,
          mode: "project",
          cwd: PROJECT_CWD,
          title: "E2E 错误卡",
          model: null,
          thinkingLevel: "medium",
          sessionFile,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      null,
      2,
    ),
    "utf-8",
  );
}

test("错误卡：原始错误直接展示，不需要点「详情」", async () => {
  const app = await launchApp({ seed });
  const window = await app.firstWindow();

  const row = window.locator("div.group", { hasText: "E2E 错误卡" }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();

  const card = window.getByTestId("run-error-card");
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card).toContainText("任务因错误中断");
  // 原始错误无需任何点击就在页面上（可换行展示，但内容完整）
  const raw = window.getByTestId("run-error-raw");
  await expect(raw).toBeVisible();
  await expect(raw).toHaveText(RAW_ERROR);
  // 旧的「详情」折叠入口已经移除
  await expect(window.getByTestId("run-error-detail-toggle")).toHaveCount(0);
  // 建议文案不再让人去点「详情」
  await expect(card).not.toContainText("展开「详情」");

  await app.close();
});
