import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

/**
 * 步骤交互回归（Qoder 风格活动组）：
 * - 任务结束后只留最终总结，中间阶段正文与活动组收进一个过程折叠区；
 * - 展开过程后按到达顺序恢复「阶段正文 + 已处理活动组」；
 * - 活动组可继续展开，看到一步一行的思考/工具调用及输入输出；
 * - 运行中进度行始终跟随当前步骤，活动组收起后仍然可见。
 */

const PROJECT_CWD = "/tmp/spcode-e2e-run-activity";
const SESSION_ID = "e2e-run-activity-1";
const THINKING = "先确认 README 的现有结构";
const STAGE1 = "我先看下这份 README，再决定改哪几段。";
const STAGE2 = "已经改好了，接下来更新目录。";
const FINAL = "改完了：新增快速开始，重排了配置说明。";

const ACTIVE_CWD = "/tmp/spcode-e2e-run-progress";
const ACTIVE_SESSION_ID = "e2e-run-progress-1";
const ACTIVE_PROMPT = "开始测试运行中的进度";

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

/** 运行中用例：只预置一条用户消息，随后通过宿主事件驱动一次真实运行 */
function seedActive(home: string): void {
  mkdirSync(ACTIVE_CWD, { recursive: true });
  const sessionsDir = join(home, "agent", "sessions", "-tmp-spcode-e2e-run-progress");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "2026-02-01T00-00-00-000Z_e2erunprogress1.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "e2erunprogress1",
      timestamp: "2026-02-01T00:00:00.000Z",
      cwd: ACTIVE_CWD,
    }),
    JSON.stringify({
      type: "message",
      id: "cccc0001",
      parentId: null,
      timestamp: "2026-02-01T00:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: ACTIVE_PROMPT }],
        timestamp: 1769904000000,
      },
    }),
  ];
  writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf-8");
  writeFileSync(
    join(home, "sessions.json"),
    JSON.stringify(
      [
        {
          id: ACTIVE_SESSION_ID,
          mode: "project",
          cwd: ACTIVE_CWD,
          title: "E2E 运行中进度",
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

test("任务结束后只留总结，展开过程恢复完整时间线", async () => {
  const app = await launchApp({ seed });
  const window = await app.firstWindow();
  await openSession(window);

  // 默认只保留最终总结；中间阶段正文收进过程折叠区（高度 0、对辅助技术隐藏）
  await expect(window.getByText(FINAL)).toBeVisible();
  const process = window.getByTestId("run-process");
  await expect(process).toHaveCount(1);
  await expect(process).toHaveAttribute("data-state", "collapsed");
  const processGrid = process.locator(".collapse-grid").first();
  await expect(processGrid).toHaveAttribute("aria-hidden", "true");
  expect(await processGrid.evaluate((el) => el.getBoundingClientRect().height)).toBe(0);
  const processHeader = window.getByTestId("run-process-header");
  await expect(processHeader).toHaveAttribute("aria-expanded", "false");

  // 展开过程：阶段正文与两个活动组按到达顺序恢复，总结仍在最下方
  await processHeader.click();
  await expect(process).toHaveAttribute("data-state", "expanded");
  await expect(processGrid).toHaveAttribute("aria-hidden", "false");
  await expect.poll(() => processGrid.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(0);
  await expect(window.getByText(STAGE1)).toBeVisible();
  await expect(window.getByText(STAGE2)).toBeVisible();
  await expect(window.getByText(FINAL)).toBeVisible();

  const groups = window.getByTestId("run-activity");
  await expect(groups).toHaveCount(2);
  await expect(groups.first()).toHaveAttribute("data-state", "done");
  const headers = window.getByTestId("run-activity-header");
  await expect(headers).toHaveCount(2);
  await expect(headers.first()).toHaveAttribute("aria-expanded", "false");

  // 活动组可继续展开：看到读文件步骤
  await headers.first().click();
  await expect(headers.first()).toHaveAttribute("aria-expanded", "true");
  const firstGroup = groups.first();
  await expect(firstGroup.locator(".collapse-grid").first()).toHaveAttribute("aria-hidden", "false");
  const steps = firstGroup.getByTestId("run-tool-step");
  await expect(steps).toHaveCount(1);
  await expect(steps.first()).toHaveAttribute("data-tool", "read");
  await expect(steps.first()).toHaveAttribute("data-status", "done");

  // 点击步骤展开输入/响应面板
  await steps.first().getByRole("button").click();
  await expect(steps.first().getByRole("button")).toHaveAttribute("aria-expanded", "true");
  await expect(steps.first().locator(".collapse-grid")).toHaveAttribute("aria-hidden", "false");
  await expect(firstGroup.getByTestId("run-step-detail")).toBeVisible();

  await app.close();
});

test("运行中：进度行跟随当前步骤，活动组收起后仍可见", async () => {
  const app = await launchApp({ seed: seedActive });
  const window = await app.firstWindow();
  const row = window.locator("div.group", { hasText: "E2E 运行中进度" }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();
  await expect(window.getByText(ACTIVE_PROMPT)).toBeVisible({ timeout: 15000 });

  const send = (event: unknown) =>
    app.evaluate(
      ({ BrowserWindow }, payload) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send("spcode:host-event", payload);
      },
      { type: "session.event", sessionId: ACTIVE_SESSION_ID, event },
    );

  await send({ type: "agent_start" });
  await send({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "先确认应用是否已安装。" },
  });

  const progress = window.getByTestId("run-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute("data-kind", "thinking");

  await send({
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "bash",
    args: { command: "open -a /Applications/Maccy.app && sleep 2 && pgrep -l Maccy" },
  });
  await expect(progress).toHaveAttribute("data-kind", "tool");
  await expect(progress).toHaveAttribute("data-tool", "bash");

  // 收起活动组：步骤不可见，但进度行仍显示当前工具
  const header = window.getByTestId("run-activity-header").first();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute("data-kind", "tool");
  await expect(progress).toHaveAttribute("data-tool", "bash");

  // 阶段状态不再占用底部状态条（行内进度行是唯一提示）
  await expect(window.getByTestId("run-status-bar")).toHaveCount(0);

  await send({ type: "agent_settled" });
  await app.close();
});
