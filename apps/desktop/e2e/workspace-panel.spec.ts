import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

const SESSION_ID = "e2e-workspace-panel";
const TITLE = "E2E 工作区文件预览";
const CWD = mkdtempSync(join(tmpdir(), "spcode-e2e-workspace-"));
const README_TEXT = "这是从工具调用打开的文件内容";
const NOTES_TEXT = "纯文本文件第二标签";

function seed(home: string): void {
  writeFileSync(join(CWD, "README.md"), `# 工作区预览\n\n${README_TEXT}\n`, "utf-8");
  writeFileSync(join(CWD, "notes.txt"), `${NOTES_TEXT}\n`, "utf-8");

  const sessionsDir = join(home, "agent", "sessions", "workspace-panel");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "session.jsonl");
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: SESSION_ID,
      timestamp: "2026-02-01T00:00:00.000Z",
      cwd: CWD,
    }),
    JSON.stringify({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-02-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "读取并整理文件" }], timestamp: 1769904000000 },
    }),
    JSON.stringify({
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-02-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "read-readme", name: "read", arguments: { path: "README.md" } },
          { type: "toolCall", id: "write-notes", name: "write", arguments: { path: "notes.txt", content: NOTES_TEXT } },
        ],
        api: "anthropic-messages",
        provider: "test",
        model: "t",
        usage,
        stopReason: "stop",
        timestamp: 1769904001000,
      },
    }),
    JSON.stringify({
      type: "message",
      id: "r1",
      parentId: "a1",
      timestamp: "2026-02-01T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "read-readme",
        toolName: "read",
        content: [{ type: "text", text: README_TEXT }],
        isError: false,
        timestamp: 1769904002000,
      },
    }),
    JSON.stringify({
      type: "message",
      id: "r2",
      parentId: "r1",
      timestamp: "2026-02-01T00:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "write-notes",
        toolName: "write",
        content: [{ type: "text", text: "Successfully wrote to notes.txt" }],
        isError: false,
        timestamp: 1769904003000,
      },
    }),
    JSON.stringify({
      type: "message",
      id: "a2",
      parentId: "r2",
      timestamp: "2026-02-01T00:00:04.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "文件已处理：[README.md](file:README.md)，也可以看[notes.txt](notes.txt)。",
          },
        ],
        api: "anthropic-messages",
        provider: "test",
        model: "t",
        usage,
        stopReason: "stop",
        timestamp: 1769904004000,
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
        cwd: CWD,
        title: TITLE,
        model: null,
        thinkingLevel: "medium",
        sessionFile,
        todos: [
          { content: "已完成任务", status: "completed" },
          { content: "正在整理文件", activeForm: "正在整理文件", status: "in_progress" },
          { content: "待处理任务", status: "pending" },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
    "utf-8",
  );
}

function seedChat(home: string): void {
  const scratch = join(home, "scratch");
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, "chat-note.md"), "# Chat 文件\n\n聊天会话正文链接预览\n", "utf-8");
  const sessionsDir = join(home, "agent", "sessions", "workspace-chat");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "e2e-workspace-chat",
      timestamp: "2026-02-01T00:00:00.000Z",
      cwd: "",
    }),
    JSON.stringify({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-02-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "生成一个文件" }], timestamp: 1769904000000 },
    }),
    JSON.stringify({
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-02-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "已生成 [chat-note.md](chat-note.md)" }],
        timestamp: 1769904001000,
      },
    }),
  ];
  writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf-8");
  writeFileSync(
    join(home, "sessions.json"),
    JSON.stringify([
      {
        id: "e2e-workspace-chat",
        mode: "chat",
        cwd: "",
        title: "E2E Chat 工作区",
        model: null,
        thinkingLevel: "medium",
        sessionFile,
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
    "utf-8",
  );
}

test("工具调用可在右侧预览文件，多标签与顶栏唤回不丢状态，任务清单位于顶部", async () => {
  const app = await launchApp({ seed });
  const window = await app.firstWindow();
  await window.locator("div.group", { hasText: TITLE }).first().click();
  await expect(window.getByText("文件已处理")).toBeVisible({ timeout: 15000 });

  const panel = window.getByTestId("workspace-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("workspace-todo-toggle")).toContainText("1/3");
  await expect(panel.getByTestId("work-task")).toHaveCount(3);
  // 任务区在文件标签之前，面板不只有打开计划文件时才出现。
  const sectionTop = await panel.getByTestId("workspace-todo-section").evaluate((el) => el.getBoundingClientRect().top);
  await window.getByTestId("run-process-header").click();
  await window.getByTestId("run-activity-header").click();

  const readStep = window.locator('[data-testid="run-tool-step"][data-tool="read"]');
  await expect(readStep).toBeVisible();
  await readStep.getByTestId("run-tool-preview").click();
  await expect(panel.getByTestId("workspace-file-tab")).toHaveCount(1);
  await expect(panel.getByTestId("workspace-file-content")).toContainText(README_TEXT);
  const tabsTop = await panel.getByTestId("workspace-file-tabs").evaluate((el) => el.getBoundingClientRect().top);
  expect(sectionTop).toBeLessThan(tabsTop);

  const writeStep = window.locator('[data-testid="run-tool-step"][data-tool="write"]');
  await writeStep.getByTestId("run-tool-preview").click();
  await expect(panel.getByTestId("workspace-file-tab")).toHaveCount(2);
  const notesTab = panel.getByTestId("workspace-file-tab").filter({ hasText: "notes.txt" });
  await expect(notesTab).toHaveAttribute("data-active", "true");
  await expect(panel.getByTestId("workspace-file-content")).toContainText(NOTES_TEXT);

  // 顶栏收起/唤回只改变可见性，不清空文件标签和当前预览。
  await window.getByTestId("workspace-panel-toggle").click();
  await expect(panel).toHaveCount(0);
  await window.getByTestId("workspace-panel-toggle").click();
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("workspace-file-tab")).toHaveCount(2);
  await expect(panel.getByTestId("workspace-file-content")).toContainText(NOTES_TEXT);

  // 关闭当前标签后焦点回到相邻文件；整个面板也能独立收起。
  await notesTab.getByRole("button", { name: "关闭 notes.txt", exact: true }).click();
  await expect(panel.getByTestId("workspace-file-tab")).toHaveCount(1);
  await expect(panel.getByTestId("workspace-file-content")).toContainText(README_TEXT);
  await window.getByTestId("workspace-panel-close").click();
  await expect(panel).toHaveCount(0);
  await window.getByTestId("workspace-panel-toggle").click();
  await expect(panel).toBeVisible();

  await app.close();
});

test("模型正文中的 file: 与普通相对文件链接直接在右侧打开，重复点击复用标签", async () => {
  const app = await launchApp({ seed });
  const window = await app.firstWindow();
  await window.locator("div.group", { hasText: TITLE }).first().click();
  await expect(window.getByText("文件已处理")).toBeVisible({ timeout: 15000 });

  const panel = window.getByTestId("workspace-panel");
  await expect(panel).toBeVisible();
  await window.getByTestId("workspace-file-link").filter({ hasText: "README.md" }).click();
  await expect(panel.getByTestId("workspace-file-tab")).toHaveCount(1);
  await expect(panel.getByTestId("workspace-file-content")).toContainText(README_TEXT);

  await window.getByTestId("workspace-file-link").filter({ hasText: "notes.txt" }).click();
  await expect(panel.getByTestId("workspace-file-tab")).toHaveCount(2);
  await expect(panel.getByTestId("workspace-file-content")).toContainText(NOTES_TEXT);

  // 同一文件再次从正文打开，只聚焦并刷新已有标签，不重复堆叠。
  await window.getByTestId("workspace-file-link").filter({ hasText: "README.md" }).click();
  await expect(panel.getByTestId("workspace-file-tab")).toHaveCount(2);
  await expect(panel.getByTestId("workspace-file-tab").filter({ hasText: "README.md" })).toHaveAttribute(
    "data-active",
    "true",
  );
  await expect(panel.getByTestId("workspace-file-content")).toContainText(README_TEXT);

  await app.close();
});

test("chat 会话的相对文件链接由主进程映射到 scratch 并打开面板", async () => {
  const app = await launchApp({ seed: seedChat });
  const window = await app.firstWindow();
  await window.locator("div.group", { hasText: "E2E Chat 工作区" }).first().click();
  const link = window.getByTestId("workspace-file-link");
  await expect(link).toBeVisible({ timeout: 15000 });
  await expect(window.getByTestId("workspace-panel")).toHaveCount(0);
  await link.click();
  await expect(window.getByTestId("workspace-panel")).toBeVisible();
  await expect(window.getByTestId("workspace-file-content")).toContainText("聊天会话正文链接预览");
  await app.close();
});
