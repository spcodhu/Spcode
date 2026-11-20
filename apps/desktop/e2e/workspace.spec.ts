/**
 * 工作区面板 / Plan 链接 / Todo 持久化 E2E（合并自 workspace-panel、plan-panel、todo-persistence 三个 spec）：
 * 只保留必须真跑 Electron 的端到端价值——真实落盘预览、主进程路径映射、面板开合策略、
 * 跨重启恢复与整树联动；纯展示与纯计算断言由 apps/desktop/test/*.test.ts 覆盖。
 * 合并后一条 test 内会多次冷启动应用，断言与 timeout 保持原样。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

// —— 工作区夹具（原 workspace-panel.spec.ts） ——
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
            text: "文件已处理：[README.md](file:README.md)，也可以看[notes.txt](notes.txt)。\n\n- 本轮清单：先读 [README.md](README.md)。",
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

// —— Plan 面板夹具（原 plan-panel.spec.ts）；seed 更名避免同名函数冲突 ——
const PLAN_SESSION_ID = "e2e-plan-panel-1";
const PLAN_TITLE = "E2E Plan 阅读面板";
const PROJECT_CWD = "/tmp/spcode-e2e-plan-panel";

function seedPlan(home: string): void {
  mkdirSync(PROJECT_CWD, { recursive: true });
  const planPath = join(home, "plans", `${PLAN_SESSION_ID}.md`);
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
        id: PLAN_SESSION_ID,
        mode: "project",
        cwd: PROJECT_CWD,
        title: PLAN_TITLE,
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

// —— Todo 持久化夹具（原 todo-persistence.spec.ts）；seed 更名避免同名函数冲突 ——
const TODO_SESSION_ID = "e2e-todo-persistence";
const TODO_TITLE = "E2E Todo 持久化";
const TODO_CWD = mkdtempSync(join(tmpdir(), "spcode-e2e-todo-cwd-"));
const TODO_TIMESTAMP = new Date(2026, 10, 2, 10, 0).getTime();
const TODOS = [
  { content: "已完成的阶段", status: "completed" },
  { content: "恢复中的任务", activeForm: "正在恢复任务", status: "in_progress" },
  { content: "等待开始的任务", status: "pending" },
];

function seedTodo(home: string): void {
  const sessionsDir = join(home, "agent", "sessions", "-tmp-spcode-e2e-todo");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: TODO_SESSION_ID,
      timestamp: "2026-11-02T02:00:00.000Z",
      cwd: TODO_CWD,
    }),
    JSON.stringify({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: new Date(TODO_TIMESTAMP).toISOString(),
      message: { role: "user", timestamp: TODO_TIMESTAMP, content: [{ type: "text", text: "继续上次的任务" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: new Date(TODO_TIMESTAMP).toISOString(),
      message: { role: "assistant", timestamp: TODO_TIMESTAMP, content: [{ type: "text", text: "继续处理中" }] },
    }),
  ];
  writeFileSync(sessionFile, `${lines.join("\n")}\n`);
  writeFileSync(
    join(home, "sessions.json"),
    JSON.stringify([
      {
        id: TODO_SESSION_ID,
        mode: "project",
        cwd: TODO_CWD,
        title: TODO_TITLE,
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
  await window.locator("div.group", { hasText: TODO_TITLE }).first().click();
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

test("工作区开合策略：空会话可开合、无待办不自动打开、手动关闭后发送不重开、卡片内滚动", async () => {
  // 本条串起 4 段各自冷启动的应用：空会话开合 / 无待办 / 有待办 / 多待办滚动。
  test.setTimeout(180_000);
  {
    const app = await launchApp({ seed: seedEmpty });
    const window = await app.firstWindow();
    await window.locator("div.group", { hasText: "E2E 空工作区" }).first().click();
    const panel = window.getByTestId("workspace-panel");
    await expect(panel).toHaveCount(0);
    const launcher = window.getByTestId("workspace-panel-toggle");
    await expect(launcher).toBeVisible({ timeout: 15000 });
    const launcherBox = await launcher.boundingBox();
    const usageBox = await window.getByTestId("session-usage-chip").boundingBox();
    expect(launcherBox).not.toBeNull();
    expect(usageBox).not.toBeNull();
    expect(launcherBox!.width).toBeLessThanOrEqual(28);
    expect(launcherBox!.height).toBeLessThanOrEqual(28);
    expect(launcherBox!.x + launcherBox!.width).toBeLessThanOrEqual(usageBox!.x);
    expect(Math.abs(launcherBox!.y + launcherBox!.height / 2 - (usageBox!.y + usageBox!.height / 2))).toBeLessThan(6);
    await launcher.click();
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("workspace-empty")).toBeVisible();
    await panel.getByTestId("workspace-panel-close").click();
    await expect(panel).toHaveCount(0);
    await launcher.click();
    await expect(panel.getByTestId("workspace-empty")).toBeVisible();
    await app.close();
  }

  {
    const app = await launchApp({ seed: seedEmpty });
    const window = await app.firstWindow();
    await window.locator("div.group", { hasText: "E2E 空工作区" }).first().click();
    const panel = window.getByTestId("workspace-panel");
    const launcher = window.getByTestId("workspace-panel-toggle");
    const composer = window.getByTestId("composer-input");
    await expect(panel).toHaveCount(0);

    await composer.fill("只回复一句话");
    await window.getByTestId("composer-send").click();
    await expect(window.getByText("只回复一句话", { exact: true })).toBeVisible();
    await expect(panel).toHaveCount(0);

    await launcher.click();
    await expect(panel).toBeVisible();
    await window.getByTestId("workspace-panel-close").click();
    await expect(panel).toHaveCount(0);
    await composer.fill("再次发送也保持关闭");
    await window.getByTestId("composer-send").click();
    await expect(window.getByText("再次发送也保持关闭", { exact: true })).toBeVisible();
    await expect(panel).toHaveCount(0);

    await launcher.click();
    await expect(panel).toBeVisible();
    await app.close();
  }

  {
    const app = await launchApp({ seed });
    const window = await app.firstWindow();
    await window.locator("div.group", { hasText: TITLE }).first().click();
    const panel = window.getByTestId("workspace-panel");
    await expect(panel).toBeVisible({ timeout: 15000 });
    await window.getByTestId("workspace-panel-close").click();
    await expect(panel).toHaveCount(0);

    await window.getByTestId("composer-input").fill("继续处理但保持面板关闭");
    await window.getByTestId("composer-send").click();
    await expect(window.getByText("继续处理但保持面板关闭", { exact: true })).toBeVisible();
    await expect(panel).toHaveCount(0);

    await app.evaluate(({ BrowserWindow }, sessionId) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("spcode:host-event", {
        type: "session.todo",
        sessionId,
        todos: [
          { content: "已完成任务", activeForm: "正在完成任务", status: "completed" },
          { content: "新的待办", activeForm: "正在处理新的待办", status: "in_progress" },
        ],
      });
    }, SESSION_ID);
    await expect(panel).toHaveCount(0);

    await window.getByTestId("workspace-panel-toggle").click();
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("workspace-todo-toggle")).toContainText("1/2");
    await app.close();
  }

  {
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
  }
});

test("文件预览：工具调用预览、多标签、顶栏唤回、file: 与相对链接复用", async () => {
  // 本条串起 3 段各自冷启动的应用：工具调用预览 / 正文 file: 与相对链接 / chat scratch 映射。
  test.setTimeout(180_000);
  {
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
    const sectionTop = await panel
      .getByTestId("workspace-todo-section")
      .evaluate((el) => el.getBoundingClientRect().top);
    await window.getByTestId("run-process-header").click();

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

    // 原生拖拽区内的收起按钮必须可点击；顶栏唤回保留文件标签、选中项和真实文件预览。
    await panel.getByTestId("workspace-panel-collapse").click();
    await expect(panel).toHaveCount(0);
    await window.getByTestId("workspace-panel-toggle").click();
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("workspace-file-tab")).toHaveCount(2);
    await expect(notesTab).toHaveAttribute("data-active", "true");
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
  }

  {
    const app = await launchApp({ seed });
    const window = await app.firstWindow();
    await window.locator("div.group", { hasText: TITLE }).first().click();
    await expect(window.getByText("文件已处理")).toBeVisible({ timeout: 15000 });

    const panel = window.getByTestId("workspace-panel");
    await expect(panel).toBeVisible();
    const links = window.getByTestId("workspace-file-link");
    await expect(links).toHaveCount(3);
    // 文件入口留在原 Markdown 结构里：段落里的仍在段内，列表项里的仍在 li 内
    const paragraph = window.locator("p", { has: links.first() }).first();
    await expect(paragraph).toContainText("文件已处理");
    await expect(paragraph).toContainText("也可以看");
    await expect(paragraph.getByTestId("workspace-file-link")).toHaveCount(2);
    const listItem = window.locator("li", { has: window.getByTestId("workspace-file-link") });
    await expect(listItem).toHaveCount(1);
    await expect(listItem).toContainText("本轮清单");
    const firstLinkBox = await links.nth(0).boundingBox();
    const secondLinkBox = await links.nth(1).boundingBox();
    expect(firstLinkBox).not.toBeNull();
    expect(secondLinkBox).not.toBeNull();
    expect(Math.abs(firstLinkBox!.y - secondLinkBox!.y)).toBeLessThan(4);
    expect(firstLinkBox!.height).toBeLessThanOrEqual(28);
    expect(secondLinkBox!.height).toBeLessThanOrEqual(28);
    await links.filter({ hasText: "README.md" }).first().click();
    await expect(panel.getByTestId("workspace-file-tab")).toHaveCount(1);
    await expect(panel.getByTestId("workspace-file-content")).toContainText(README_TEXT);

    await links.filter({ hasText: "notes.txt" }).click();
    await expect(panel.getByTestId("workspace-file-tab")).toHaveCount(2);
    await expect(panel.getByTestId("workspace-file-content")).toContainText(NOTES_TEXT);

    // 同一文件再次从正文打开，只聚焦并刷新已有标签，不重复堆叠。
    await links.filter({ hasText: "README.md" }).first().click();
    await expect(panel.getByTestId("workspace-file-tab")).toHaveCount(2);
    await expect(panel.getByTestId("workspace-file-tab").filter({ hasText: "README.md" })).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect(panel.getByTestId("workspace-file-content")).toContainText(README_TEXT);

    await app.close();
  }

  {
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
  }
});

test("Plan 链接打开面板并显式开始，Todo 进度重启后恢复", async () => {
  // 本条串起 2 段：Plan 链接打开面板（1 次启动），Todo 进度跨重启恢复（前后两次启动都保留）。
  test.setTimeout(180_000);
  {
    const app = await launchApp({ seed: seedPlan });
    const window = await app.firstWindow();
    const row = window.locator("div.group", { hasText: PLAN_TITLE }).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.click();

    const link = window.getByTestId("plan-file-link");
    await expect(link).toBeVisible({ timeout: 15000 });
    await expect(link).toContainText("PLAN.md");
    await expect(window.getByTestId("question-submit")).toHaveCount(0);
    await link.click();

    const panel = window.getByTestId("workspace-panel");
    await expect(panel).toBeVisible();
    await expect(window.getByRole("heading", { name: "三栏实施计划" })).toBeVisible();
    await expect(window.getByTestId("workspace-file-content")).toContainText(
      "这是一段用于验证右侧完整 Markdown 阅读体验的计划正文",
    );

    // 可关闭后重新打开，工作区面板不会与消息流互相挤压。
    await window.getByTestId("workspace-panel-close").click();
    await expect(panel).toHaveCount(0);
    await link.click();
    await expect(panel).toBeVisible();

    await window.getByTestId("plan-start-execution").click();
    await expect(window.getByTestId("plan-start-execution")).toHaveCount(0);
    await expect(window.getByText(/用户已审阅并明确批准计划文件/).first()).toBeVisible();
    await expect(panel).toBeVisible();

    await app.close();
  }

  {
    const home = mkdtempSync(join(tmpdir(), "spcode-e2e-todo-home-"));
    let app = await launchApp({ spcodeHome: home, seed: seedTodo });
    let window = await app.firstWindow();
    await assertRestored(window);
    await app.close();

    app = await launchApp({ spcodeHome: home });
    window = await app.firstWindow();
    await assertRestored(window);
    await app.close();
  }
});
