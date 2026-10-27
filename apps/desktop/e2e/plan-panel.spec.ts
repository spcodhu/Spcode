import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

const SESSION_ID = "e2e-plan-panel-1";
const TITLE = "E2E Plan 阅读面板";
const PROJECT_CWD = "/tmp/spcode-e2e-plan-panel";

function seed(home: string): void {
  mkdirSync(PROJECT_CWD, { recursive: true });
  const planPath = join(home, "plans", `${SESSION_ID}.md`);
  mkdirSync(join(home, "plans"), { recursive: true });
  writeFileSync(
    planPath,
    "# 三栏实施计划\n\n1. 先完成数据层改造\n2. 再补齐界面与测试\n\n这是一段用于验证右侧完整 Markdown 阅读体验的计划正文。\n",
    "utf-8",
  );

  const sessionsDir = join(home, "agent", "sessions", "-tmp-spcode-e2e-plan-panel");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "2026-02-01T00-00-00-000Z_e2eplanpanel1.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "e2eplanpanel1",
      timestamp: "2026-02-01T00:00:00.000Z",
      cwd: PROJECT_CWD,
    }),
    JSON.stringify({
      type: "message",
      id: "aaaa0001",
      parentId: null,
      timestamp: "2026-02-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "请先出计划" }], timestamp: 1769904000000 },
    }),
    JSON.stringify({
      type: "message",
      id: "aaaa0002",
      parentId: "aaaa0001",
      timestamp: "2026-02-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `调研完成，计划已落盘。[PLAN.md](plan:${planPath})` }],
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
  writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf-8");
  writeFileSync(
    join(home, "sessions.json"),
    JSON.stringify([
      {
        id: SESSION_ID,
        mode: "project",
        cwd: PROJECT_CWD,
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
    "utf-8",
  );
}

test("Plan 链接打开第三栏，用户显式开始后关闭计划模式并发送执行指令", async () => {
  const app = await launchApp({ seed });
  const window = await app.firstWindow();
  const row = window.locator("div.group", { hasText: TITLE }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();

  const link = window.getByTestId("plan-file-link");
  await expect(link).toBeVisible({ timeout: 15000 });
  await expect(link).toContainText("PLAN.md");
  await expect(window.getByTestId("question-submit")).toHaveCount(0);
  await link.click();

  const panel = window.getByTestId("plan-panel");
  await expect(panel).toBeVisible();
  await expect(window.getByRole("heading", { name: "三栏实施计划" })).toBeVisible();
  await expect(window.getByTestId("plan-content")).toContainText(
    "这是一段用于验证右侧完整 Markdown 阅读体验的计划正文",
  );

  // 可关闭后重新打开，执行面板不会与消息流互相挤压。
  await window.getByTestId("plan-panel-close").click();
  await expect(panel).toHaveCount(0);
  await link.click();
  await expect(panel).toBeVisible();

  await window.getByTestId("plan-start-execution").click();
  await expect(window.getByTestId("plan-start-execution")).toHaveCount(0);
  await expect(window.getByText(/用户已审阅并明确批准计划文件/).first()).toBeVisible();
  await expect(panel).toBeVisible();

  await app.close();
});
