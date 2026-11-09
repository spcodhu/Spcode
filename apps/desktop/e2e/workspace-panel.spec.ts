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

function seed(home: string, todoCount = 3): void {
  mkdirSync(join(CWD, "assets"), { recursive: true });
  writeFileSync(
    join(CWD, "assets", "architecture.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  writeFileSync(
    join(CWD, "README.md"),
    `# 工作区预览\n\n${README_TEXT}\n\n![架构图](assets/architecture.png)\n`,
    "utf-8",
  );
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
        todos: Array.from({ length: todoCount }, (_, index) => ({
          content: index === 0 ? "已完成任务" : index === 1 ? "正在整理文件" : `待处理任务 ${index + 1}`,
          ...(index === 1 ? { activeForm: "正在整理文件" } : {}),
          status: index === 0 ? "completed" : index === 1 ? "in_progress" : "pending",
        })),
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

function seedEmpty(home: string): void {
  const sessionsDir = join(home, "agent", "sessions", "workspace-empty");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "e2e-workspace-empty",
      timestamp: "2026-02-01T00:00:00.000Z",
      cwd: CWD,
    }),
    JSON.stringify({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-02-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "还没有任何内容" }], timestamp: 1769904000000 },
    }),
  ];
  writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf-8");
  writeFileSync(
    join(home, "sessions.json"),
    JSON.stringify([
      {
        id: "e2e-workspace-empty",
        mode: "project",
        cwd: CWD,
        title: "E2E 空工作区",
        model: null,
        thinkingLevel: "medium",
        sessionFile,
        todos: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
    "utf-8",
  );
}

test("任务卡片左右留白、默认展开且固定高度，多项任务在卡片内滚动", async () => {
  const app = await launchApp({ seed: (home) => seed(home, 12) });
  const window = await app.firstWindow();
  await window.locator("div.group", { hasText: TITLE }).first().click();
  const panel = window.getByTestId("workspace-panel");
  await expect(panel).toBeVisible({ timeout: 15000 });
  await expect(panel.getByTestId("workspace-todo-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(panel.getByTestId("work-task")).toHaveCount(12);

  const panelBox = await panel.boundingBox();
  const cardBox = await panel.getByTestId("workspace-todo-section").locator(":scope > div").boundingBox();
  expect(panelBox).not.toBeNull();
  expect(cardBox).not.toBeNull();
  expect(cardBox!.x).toBeGreaterThan(panelBox!.x);
  expect(cardBox!.x + cardBox!.width).toBeLessThan(panelBox!.x + panelBox!.width);
  expect(Math.round(cardBox!.height)).toBe(260);

  const list = panel.getByTestId("workspace-todo-list");
  const metrics = await list.evaluate((el) => ({
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    overflowY: getComputedStyle(el).overflowY,
  }));
  expect(metrics.overflowY).toBe("auto");
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await app.close();
});

test("空会话也能通过右侧悬浮按钮打开、关闭并再次打开工作区", async () => {
  const app = await launchApp({ seed: seedEmpty });
  const window = await app.firstWindow();
  await window.locator("div.group", { hasText: "E2E 空工作区" }).first().click();
  const panel = window.getByTestId("workspace-panel");
  await expect(panel).toHaveCount(0);
  const launcher = window.getByTestId("workspace-panel-toggle");
  await expect(launcher).toBeVisible({ timeout: 15000 });
  await launcher.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("workspace-empty")).toBeVisible();
  await panel.getByTestId("workspace-panel-close").click();
  await expect(panel).toHaveCount(0);
  await launcher.click();
  await expect(panel.getByTestId("workspace-empty")).toBeVisible();
  await app.close();
});

test("工具调用可在右侧预览文件，多标签与悬浮按钮唤回不丢状态，任务清单位于顶部", async () => {
  const app = await launchApp({ seed });
  const window = await app.firstWindow();
  await window.locator("div.group", { hasText: TITLE }).first().click();
  await expect(window.getByText("文件已处理")).toBeVisible({ timeout: 15000 });

  const panel = window.getByTestId("workspace-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("workspace-todo-toggle")).toContainText("1/3");
  await expect(panel.getByTestId("work-task")).toHaveCount(3);
  // 助手正文明确分享的文件自动进入列表，工具调用本身不会生成额外交付项。
  await expect(panel.getByTestId("workspace-delivered-file")).toHaveCount(2);
  // 任务区在文件标签之前，面板不只有打开计划文件时才出现。
  const sectionTop = await panel.getByTestId("workspace-todo-section").evaluate((el) => el.getBoundingClientRect().top);
  await window.getByTestId("run-process-header").click();
  await window.getByTestId("run-activity-header").click();

  const readStep = window.locator('[data-testid="run-tool-step"][data-tool="read"]');
  await expect(readStep).toBeVisible();
  await readStep.getByTestId("run-tool-preview").click();
  await expect(panel.getByTestId("workspace-file-tab")).toHaveCount(1);
  await expect(panel.getByTestId("workspace-file-content")).toContainText(README_TEXT);
  await expect(panel.getByTestId("workspace-markdown-image")).toBeVisible();
  await expect(panel.getByTestId("workspace-markdown-image")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(panel.getByTestId("workspace-image-error")).toHaveCount(0);
  const tabsTop = await panel.getByTestId("workspace-file-tabs").evaluate((el) => el.getBoundingClientRect().top);
  expect(sectionTop).toBeLessThan(tabsTop);

  const writeStep = window.locator('[data-testid="run-tool-step"][data-tool="write"]');
  await writeStep.getByTestId("run-tool-preview").click();
  await expect(panel.getByTestId("workspace-file-tab")).toHaveCount(2);
  const notesTab = panel.getByTestId("workspace-file-tab").filter({ hasText: "notes.txt" });
  await expect(notesTab).toHaveAttribute("data-active", "true");
  await expect(panel.getByTestId("workspace-file-content")).toContainText(NOTES_TEXT);

  // 保留标签的同时可返回会话文件列表，并从列表再次打开交付文件。
  await panel.getByTestId("workspace-file-list-back").click();
  await expect(panel.getByTestId("workspace-file-list")).toBeVisible();
  await panel.getByTestId("workspace-delivered-file").filter({ hasText: "notes.txt" }).click();
  await expect(panel.getByTestId("workspace-file-content")).toContainText(NOTES_TEXT);

  // 右侧悬浮按钮收起/唤回只改变可见性，不清空文件标签和当前预览。
  await window.getByTestId("workspace-panel-close").click();
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
  const inlineGroup = window.getByTestId("markdown-inline-group");
  await expect(inlineGroup).toHaveCount(1);
  const inlineLinks = inlineGroup.getByTestId("workspace-file-link");
  await expect(inlineLinks).toHaveCount(2);
  const firstLinkBox = await inlineLinks.nth(0).boundingBox();
  const secondLinkBox = await inlineLinks.nth(1).boundingBox();
  expect(firstLinkBox).not.toBeNull();
  expect(secondLinkBox).not.toBeNull();
  expect(Math.abs(firstLinkBox!.y - secondLinkBox!.y)).toBeLessThan(4);
  expect(firstLinkBox!.height).toBeLessThanOrEqual(28);
  expect(secondLinkBox!.height).toBeLessThanOrEqual(28);
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
