import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

/**
 * 步骤交互回归（Qoder 风格活动组）：
 * - 连续思考/工具调用折叠成一个「已处理」活动组，步骤默认收起；
 * - 组内一步一行，点击步骤展开输入/响应；
 * - 所有阶段性正文按到达顺序常驻，不再有完整/精简两档。
 */

const PROJECT_CWD = "/tmp/spcode-e2e-run-activity";
const SESSION_ID = "e2e-run-activity-1";
const THINKING = "先确认 README 的现有结构";
const STAGE1 = "我先看下这份 README，再决定改哪几段。";
const STAGE2 = "已经改好了，接下来更新目录。";
const FINAL = "改完了：新增快速开始，重排了配置说明。";

function seed(home: string): void {
  mkdirSync(PROJECT_CWD, { recursive: true });
  const sessionsDir = join(home, "agent", "sessions", "-tmp-spcode-e2e-run-activity");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "2026-02-01T00-00-00-000Z_e2erunactivity1.jsonl");
  let n = 0;
  let parentId: string | null = null;
  // 会话投影按 parentId 链构树：每条消息必须挂在前一条后面，否则只会回放出最后一条
  const entry = (message: unknown) => {
    const id = `bbbb${String(++n).padStart(4, "0")}`;
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
      id: "e2erunactivity1",
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
          title: "E2E 步骤交互",
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
  const row = window.locator("div.group", { hasText: "E2E 步骤交互" }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();
  await expect(window.getByText(FINAL)).toBeVisible({ timeout: 15000 });
}

test("步骤交互：完成后折叠为活动组，正文按顺序常驻", async () => {
  const app = await launchApp({ seed });
  const window = await app.firstWindow();
  await openSession(window);

  // 所有阶段性正文都在（不再有完整/精简两档）
  await expect(window.getByText(STAGE1)).toBeVisible();
  await expect(window.getByText(STAGE2)).toBeVisible();
  await expect(window.getByText(FINAL)).toBeVisible();
  await expect(window.getByTestId("run-reveal-full")).toHaveCount(0);

  // 被正文打断的两段步骤各自成组，结束后都是收起态
  const groups = window.getByTestId("run-activity");
  await expect(groups).toHaveCount(2);
  await expect(groups.first()).toHaveAttribute("data-state", "done");
  const headers = window.getByTestId("run-activity-header");
  await expect(headers).toHaveCount(2);
  await expect(headers.first()).toHaveAttribute("aria-expanded", "false");

  // 展开第一组：看到读文件步骤
  await headers.first().click();
  await expect(headers.first()).toHaveAttribute("aria-expanded", "true");
  const firstGroup = groups.first();
  const steps = firstGroup.getByTestId("run-tool-step");
  await expect(steps).toHaveCount(1);
  await expect(steps.first()).toHaveAttribute("data-tool", "read");
  await expect(steps.first()).toHaveAttribute("data-status", "done");

  // 点击步骤展开输入/响应面板
  await steps.first().getByRole("button").click();
  await expect(steps.first().getByRole("button")).toHaveAttribute("aria-expanded", "true");
  await expect(firstGroup.getByTestId("run-step-detail")).toBeVisible();

  await app.close();
});
