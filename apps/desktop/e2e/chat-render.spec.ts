/**
 * 聊天消息渲染 E2E：代码块标题栏布局 / 多图横滚与图片预览 / 消息悬浮操作
 * + 运行时间线（运行中进度、结束后过程折叠）。
 * 断言锚 data-testid / role，不锚展示文案（AGENTS.md 纪律）。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

// ---------------------------------------------------------------------------
// 夹具一：代码块（标题栏内复制按钮与语言标签居中）
// ---------------------------------------------------------------------------
const CODE_BLOCK_SESSION_ID = "e2e-markdown-code-block";
const CODE_BLOCK_TITLE = "代码块布局";
const CODE_BLOCK_CWD = mkdtempSync(join(tmpdir(), "spcode-e2e-code-block-"));

function seedCodeBlock(home: string): void {
  const sessionsDir = join(home, "agent", "sessions", "-tmp-spcode-e2e-code-block");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "e2emarkdowncodeblock",
      timestamp: "2026-02-01T00:00:00.000Z",
      cwd: CODE_BLOCK_CWD,
    }),
    JSON.stringify({
      type: "message",
      id: "a1",
      parentId: null,
      timestamp: "2026-02-01T00:00:01.000Z",
      message: {
        role: "assistant",
        timestamp: 1769904001000,
        content: [
          {
            type: "text",
            text: "下面是一段代码：\n\n```tsx\nexport function Hello() {\n  return <strong>Hello, Spcode!</strong>;\n}\n```",
          },
        ],
      },
    }),
  ];
  writeFileSync(sessionFile, `${lines.join("\n")}\n`);
  writeFileSync(
    join(home, "sessions.json"),
    JSON.stringify([
      {
        id: CODE_BLOCK_SESSION_ID,
        mode: "project",
        cwd: CODE_BLOCK_CWD,
        title: CODE_BLOCK_TITLE,
        model: null,
        thinkingLevel: "medium",
        sessionFile,
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// 夹具二：多图消息（单行横滚、图片预览缩放与切图复位）
// ---------------------------------------------------------------------------
const IMAGES_SESSION_ID = "e2e-message-images";
const IMAGES_TITLE = "多图消息";
const IMAGES_CWD = mkdtempSync(join(tmpdir(), "spcode-e2e-images-"));
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function seedImages(home: string): void {
  const sessionsDir = join(home, "agent", "sessions", "-tmp-spcode-e2e-images");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "e2emessageimages",
      timestamp: "2026-02-01T00:00:00.000Z",
      cwd: IMAGES_CWD,
    }),
    JSON.stringify({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-02-01T00:00:00.000Z",
      message: {
        role: "user",
        timestamp: 1769904000000,
        content: [
          ...[1, 2, 3, 4].map((index) => ({
            type: "image",
            data: PIXEL,
            mimeType: "image/png",
            name: `图${index}.png`,
          })),
          {
            type: "text",
            text: "这四张图并排展示\n\n[Image: original 2218x1174, displayed at 2000x1059. Multiply coordinates by 1.11 to map to original image.]",
          },
        ],
      },
    }),
  ];
  writeFileSync(sessionFile, `${lines.join("\n")}\n`);
  writeFileSync(
    join(home, "sessions.json"),
    JSON.stringify([
      {
        id: IMAGES_SESSION_ID,
        mode: "project",
        cwd: IMAGES_CWD,
        title: IMAGES_TITLE,
        model: null,
        thinkingLevel: "medium",
        sessionFile,
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// 夹具三：消息操作（悬浮时间、编辑回填）
// ---------------------------------------------------------------------------
const ACTIONS_SESSION_ID = "e2e-message-actions";
const ACTIONS_TITLE = "消息操作";
const ACTIONS_CWD = mkdtempSync(join(tmpdir(), "spcode-e2e-actions-"));
const ACTIONS_TIMESTAMP = new Date(2026, 10, 1, 22, 18).getTime();

function seedActions(home: string): void {
  const sessionsDir = join(home, "agent", "sessions", "-tmp-spcode-e2e-actions");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "e2emessageactions",
      timestamp: "2026-11-01T14:18:00.000Z",
      cwd: ACTIONS_CWD,
    }),
    JSON.stringify({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: new Date(ACTIONS_TIMESTAMP).toISOString(),
      message: { role: "user", timestamp: ACTIONS_TIMESTAMP, content: [{ type: "text", text: "需要修改的问题" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: new Date(ACTIONS_TIMESTAMP).toISOString(),
      message: { role: "assistant", timestamp: ACTIONS_TIMESTAMP, content: [{ type: "text", text: "可见回答" }] },
    }),
  ];
  writeFileSync(sessionFile, `${lines.join("\n")}\n`);
  writeFileSync(
    join(home, "sessions.json"),
    JSON.stringify([
      {
        id: ACTIONS_SESSION_ID,
        mode: "project",
        cwd: ACTIONS_CWD,
        title: ACTIONS_TITLE,
        model: null,
        thinkingLevel: "medium",
        sessionFile,
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
  );
}

test("消息渲染：代码块标题栏居中、多图横滚与预览复位、悬浮时间与编辑回填", async () => {
  // 合并后本用例含三段启动（三套夹具），放宽整体超时；断言自身 timeout 未改动
  test.setTimeout(180_000);

  // ---- 代码块复制按钮与语言标签在标题栏内垂直居中 ----
  const app = await launchApp({ seed: seedCodeBlock });
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1280, height: 840 });
  await window.locator("div.group", { hasText: CODE_BLOCK_TITLE }).first().click();

  const codeBlock = window.locator('[data-streamdown="code-block"]');
  const copyButton = window.locator('[data-streamdown="code-block-copy-button"]');
  await expect(copyButton).toBeVisible({ timeout: 15000 });
  await codeBlock.screenshot({ path: test.info().outputPath("code-block.png") });

  const label = window.locator('[data-streamdown="code-block-header"] span');
  const labelBox = await label.boundingBox();
  const buttonBox = await copyButton.boundingBox();
  expect(labelBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  const labelCenter = labelBox!.y + labelBox!.height / 2;
  const buttonCenter = buttonBox!.y + buttonBox!.height / 2;
  expect(Math.abs(labelCenter - buttonCenter)).toBeLessThanOrEqual(1);

  await app.close();

  // ---- 多图单行溢出横滚，预览支持缩放与切图复位 ----
  const app2 = await launchApp({ seed: seedImages });
  const window2 = await app2.firstWindow();
  await window2.locator("div.group", { hasText: IMAGES_TITLE }).first().click();

  const strip = window2.getByTestId("message-image-strip");
  await expect(strip).toBeVisible({ timeout: 15000 });
  await expect(window2.getByTestId("message-image")).toHaveCount(4);
  // 引擎给模型的图片坐标映射提示不应作为用户正文渲染
  await expect(window2.getByText(/Multiply coordinates by/)).toHaveCount(0);
  expect(await strip.evaluate((element) => getComputedStyle(element).flexWrap)).toBe("nowrap");
  expect(await strip.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
  const sizes = await strip.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
    images: [...element.querySelectorAll("img")].map((image) => image.getBoundingClientRect().width),
  }));
  expect(sizes.scroll > sizes.client, JSON.stringify(sizes)).toBe(true);

  await window2.getByTestId("message-image").first().click();
  await expect(window2.getByTestId("image-lightbox")).toBeVisible();
  await window2.getByTestId("image-preview-zoom-in").click();
  await expect(window2.getByTestId("image-preview-zoom-reset")).toHaveText("125%");
  await window2.getByTestId("image-preview-next").click();
  await expect(window2.getByTestId("image-preview-zoom-reset")).toHaveText("100%");
  await window2.getByTestId("image-preview-close").click();
  await expect(window2.getByTestId("image-lightbox")).toHaveCount(0);
  await app2.close();

  // ---- 消息悬浮显示时间，编辑只回填输入框且不改变历史 ----
  const app3 = await launchApp({ seed: seedActions });
  const window3 = await app3.firstWindow();
  await window3.locator("div.group", { hasText: ACTIONS_TITLE }).first().click();

  const message = window3.getByTestId("user-message");
  const bubble = message.getByText("需要修改的问题", { exact: true });
  await expect(bubble).toBeVisible({ timeout: 15000 });
  await bubble.hover();
  await expect(message.getByTestId("message-time")).toHaveText("2026-11-01 22:18");
  await expect(message.getByTestId("message-copy")).toBeVisible();

  await message.getByTestId("message-edit").click();
  await expect(window3.getByTestId("composer-input")).toHaveValue("需要修改的问题");
  await expect(message.getByText("需要修改的问题", { exact: true })).toHaveCount(1);
  await expect(window3.getByText("可见回答", { exact: true })).toHaveCount(1);
  await app3.close();
});

// ---------------------------------------------------------------------------
// 运行时间线（Qoder 风格活动组）：
// - 任务结束后只留最终总结，中间阶段正文与活动组收进一个过程折叠区；
// - 展开过程后按到达顺序恢复「阶段正文 + 已处理活动组」；
// - 活动组可继续展开，看到一步一行的思考/工具调用及输入输出；
// - 运行中进度行始终跟随当前步骤，活动组收起后仍然可见。
// ---------------------------------------------------------------------------
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

test("运行时间线：运行中进度可见，结束后只留总结、展开恢复过程", async () => {
  // 合并后本用例含两段启动（两套夹具），放宽整体超时；断言自身 timeout 未改动
  test.setTimeout(120_000);

  // ---- 运行中：进度行跟随当前步骤，活动组收起后仍可见 ----
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

  // ---- 任务结束后只留总结，展开过程恢复完整时间线 ----
  const app2 = await launchApp({ seed });
  const window2 = await app2.firstWindow();
  await openSession(window2);

  // 默认只保留最终总结；中间阶段正文收进过程折叠区（高度 0、对辅助技术隐藏）
  await expect(window2.getByText(FINAL)).toBeVisible();
  const process = window2.getByTestId("run-process");
  await expect(process).toHaveCount(1);
  await expect(process).toHaveAttribute("data-state", "collapsed");
  const processGrid = process.locator(".collapse-grid").first();
  await expect(processGrid).toHaveAttribute("aria-hidden", "true");
  expect(await processGrid.evaluate((el) => el.getBoundingClientRect().height)).toBe(0);
  const processHeader = window2.getByTestId("run-process-header");
  await expect(processHeader).toHaveAttribute("aria-expanded", "false");

  // 展开过程：阶段正文与两个活动组按到达顺序恢复，总结仍在最下方
  await processHeader.click();
  await expect(process).toHaveAttribute("data-state", "expanded");
  await expect(processGrid).toHaveAttribute("aria-hidden", "false");
  await expect.poll(() => processGrid.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(0);
  await expect(window2.getByText(STAGE1)).toBeVisible();
  await expect(window2.getByText(STAGE2)).toBeVisible();
  await expect(window2.getByText(FINAL)).toBeVisible();

  const groups = window2.getByTestId("run-activity");
  await expect(groups).toHaveCount(2);
  await expect(groups.first()).toHaveAttribute("data-state", "done");
  const headers = window2.getByTestId("run-activity-header");
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

  // 点击步骤展开输入/响应面板（read/write/edit 步骤行尾还有一个右侧预览图标按钮，.first() 取展开切换用的主按钮）
  await steps.first().getByRole("button").first().click();
  await expect(steps.first().getByRole("button").first()).toHaveAttribute("aria-expanded", "true");
  await expect(steps.first().locator(".collapse-grid")).toHaveAttribute("aria-hidden", "false");
  await expect(firstGroup.getByTestId("run-step-detail")).toBeVisible();

  await app2.close();
});
