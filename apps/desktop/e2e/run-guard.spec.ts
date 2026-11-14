import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { RUN_GUARD_CUSTOM_TYPE } from "@spcode/shared";
import { launchApp } from "./helpers";

const PROJECT_CWD = "/tmp/spcode-e2e-run-guard";
const SESSION_ID = "e2e-run-guard-1";

function seed(home: string): void {
  mkdirSync(PROJECT_CWD, { recursive: true });
  const sessionsDir = join(home, "agent", "sessions", "-tmp-spcode-e2e-run-guard");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "2026-02-03T00-00-00-000Z_e2erunguard1.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "e2erunguard1",
      timestamp: "2026-02-03T00:00:00.000Z",
      cwd: PROJECT_CWD,
    }),
    JSON.stringify({
      type: "message",
      id: "dddd0001",
      parentId: null,
      timestamp: "2026-02-03T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "执行循环测试" }], timestamp: 1769990400000 },
    }),
    JSON.stringify({
      type: "message",
      id: "dddd0002",
      parentId: "dddd0001",
      timestamp: "2026-02-03T00:00:01.000Z",
      message: {
        role: "custom",
        customType: RUN_GUARD_CUSTOM_TYPE,
        content: "Repeated tool call pause",
        display: false,
        details: {
          kind: "pause",
          pause: {
            reason: "repeatTool",
            turnCount: 5,
            toolName: "read",
            repeatCount: 5,
            argumentsPreview: '{"path":"README.md"}',
          },
        },
        timestamp: 1769990401000,
      },
    }),
  ];
  writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf-8");
  writeFileSync(
    join(home, "sessions.json"),
    JSON.stringify([
      {
        id: SESSION_ID,
        mode: "project",
        cwd: PROJECT_CWD,
        title: "E2E 运行保护",
        model: null,
        thinkingLevel: "medium",
        sessionFile,
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
  );
}

test("疑似死循环复用错误卡，展示原因并允许用户选择继续", async () => {
  const app = await launchApp({ seed });
  const window = await app.firstWindow();
  const row = window.locator("div.group", { hasText: "E2E 运行保护" }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();

  const card = window.getByTestId("run-error-card");
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card).toHaveAttribute("data-error-kind", "repeatTool");
  await expect(card).toContainText("疑似工具死循环");
  await expect(window.getByTestId("run-error-raw")).toContainText("read");
  await expect(window.getByTestId("run-error-raw")).toContainText("README.md");
  await expect(window.getByTestId("run-guard-continue")).toBeVisible();
  // 运行保护卡不是定时重试卡，不提供语义不符的调度入口。
  await expect(window.getByTestId("run-retry-toggle")).toHaveCount(0);
  await app.close();
});

test("设置页模型最大调用次数默认 2000，并可编辑持久化", async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByTitle("设置", { exact: true }).click();
  const input = window.getByTestId("max-model-turns");
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("2000");
  await input.fill("25");
  await input.press("Enter");
  await expect(input).toHaveValue("25");

  await window.keyboard.press("Escape");
  await window.getByTitle("设置", { exact: true }).click();
  await expect(window.getByTestId("max-model-turns")).toHaveValue("25");
  await app.close();
});
