import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

/**
 * 执行过程展示回归：
 * - 完整模式（默认）：任务结束后中间阶段的输出与思考/命令一起收进「工作完成」，
 *   只留最终总结在页面上（否则多轮输出的历史会淹没总结）；
 * - 精简模式：只显示最新一次阶段化输出，提供「查看完整过程」入口。
 */

const PROJECT_CWD = "/tmp/spcode-e2e-run-display";
const SESSION_ID = "e2e-run-display-1";
const THINKING = "先确认 README 的现有结构";
const STAGE1 = "我先看下这份 README，再决定改哪几段。";
const STAGE2 = "已经改好了，接下来更新目录。";
const FINAL = "改完了：新增快速开始，重排了配置说明。";

function seed(home: string): void {
  mkdirSync(PROJECT_CWD, { recursive: true });
  const sessionsDir = join(home, "agent", "sessions", "-tmp-spcode-e2e-run-display");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "2026-02-01T00-00-00-000Z_e2erundisplay1.jsonl");
  let n = 0;
  let parentId: string | null = null;
  // 会话投影按 parentId 链构树：每条消息必须挂在前一条后面，否则只会回放出最后一条
  const entry = (message: unknown) => {
    const id = `aaaa${String(++n).padStart(4, "0")}`;
    const line = JSON.stringify({
      type: "message",
      id,
      parentId,
      timestamp: "2026-02-01T00:00:00.000Z",
      message,
    });
    parentId = id;
    return line;
  };
  const assistant = (content: unknown[]) =>
    entry({
      role: "assistant",
      content,
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
      timestamp: 1769904000000,
    });
  const toolResult = (toolCallId: string, name: string) =>
    entry({
      role: "toolResult",
      toolCallId,
      toolName: name,
      content: [{ type: "text", text: "（工具输出略）" }],
      isError: false,
      timestamp: 1769904000000,
    });

  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "e2erundisplay1",
      timestamp: "2026-02-01T00:00:00.000Z",
      cwd: PROJECT_CWD,
    }),
    entry({ role: "user", content: [{ type: "text", text: "帮我改下 README" }], timestamp: 1769904000000 }),
    assistant([
      { type: "thinking", thinking: THINKING },
      { type: "toolCall", id: "t1", name: "read", arguments: { path: "README.md" } },
    ]),
    toolResult("t1", "read"),
    assistant([{ type: "text", text: STAGE1 }]),
    assistant([{ type: "toolCall", id: "t2", name: "edit", arguments: { path: "README.md" } }]),
    toolResult("t2", "edit"),
    assistant([{ type: "text", text: STAGE2 }]),
    assistant([{ type: "text", text: FINAL }]),
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
          title: "E2E 运行展示",
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

async function openSession(window: Awaited<ReturnType<Awaited<ReturnType<typeof launchApp>>["firstWindow"]>>) {
  const row = window.locator("div.group", { hasText: "E2E 运行展示" }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();
  await expect(window.getByText(FINAL)).toBeVisible({ timeout: 15000 });
}

test("完整模式：结束后只留最终总结，中间阶段输出收进「工作完成」", async () => {
  const app = await launchApp({ seed });
  const window = await app.firstWindow();
  await openSession(window);

  // 折叠行头给出步数与过程输出段数
  const header = window.getByRole("button", { name: /工作完成/ }).first();
  await expect(header).toBeVisible();
  await expect(header).toContainText("段过程输出");
  // 中间阶段输出与思考/命令一起进折叠容器（collapse-grid data-open=false 即收起）
  const stage = window.getByText(/阶段输出/).first();
  await expect(stage).toBeAttached();
  expect(await stage.evaluate((el) => el.closest(".collapse-grid")?.getAttribute("data-open"))).toBe("false");
  expect(await window.locator(".collapse-grid[data-open='false']").count()).toBeGreaterThan(0);

  // 展开后折叠容器打开（中间阶段输出随之可见）
  await header.click();
  await expect(window.locator(".collapse-grid[data-open='true']").first()).toBeAttached();
  expect(await stage.evaluate((el) => el.closest(".collapse-grid")?.getAttribute("data-open"))).toBe("true");

  await app.close();
});

test("精简模式：只显示最新一次输出，并给出「查看完整过程」入口", async () => {
  const app = await launchApp({ seed });
  const window = await app.firstWindow();
  await openSession(window);

  // 切成精简模式（设置 → 外观 → 执行过程）
  await window.getByTitle("设置", { exact: true }).click();
  await window.getByRole("button", { name: "外观" }).click();
  const group = window.getByTestId("activity-display");
  await expect(group).toBeVisible();
  await window.getByTestId("activity-display-compact").click();
  await window.getByTitle("关闭设置").click();

  await expect(window.getByText(FINAL)).toBeVisible();
  await expect(window.getByTestId("run-reveal-full").first()).toBeVisible();
  // 精简模式下默认没有「工作完成」折叠区（思考/命令/中间输出全隐藏）
  await expect(window.getByRole("button", { name: /工作完成/ })).toHaveCount(0);

  // 展开完整过程 → 折叠行头回来
  await window.getByTestId("run-reveal-full").first().click();
  await expect(window.getByRole("button", { name: /工作完成/ }).first()).toBeVisible();

  await app.close();
});
