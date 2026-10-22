import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

/**
 * Fork 会话 + 导出会话上下文的 e2e：预置注册表条目与真实 pi 会话文件，
 * 不依赖模型/网络（Fork 走 forkFrom 文件复制 + 无模型 createAgentSession；导出是纯文件读）。
 */

const PROJECT_CWD = "/tmp/spcode-e2e-project";
const SESSION_ID = "e2e-fixture-session-1";

/** 预置：sessions.json 注册表 + 一份真实 pi 会话文件（header + user + assistant） */
function seed(home: string): void {
  mkdirSync(PROJECT_CWD, { recursive: true });
  const sessionsDir = join(home, "agent", "sessions", "-tmp-spcode-e2e-project");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "2026-01-01T00-00-00-000Z_e2efixture0001.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "e2efixture0001",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: PROJECT_CWD,
    }),
    JSON.stringify({
      type: "message",
      id: "aaaa0001",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "你好，帮我看下这个项目" }], timestamp: 1767225600000 },
    }),
    JSON.stringify({
      type: "message",
      id: "aaaa0002",
      parentId: "aaaa0001",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "好的，这是一个 E2E 预置项目。" }],
        api: "anthropic-messages",
        provider: "test",
        model: "t",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          totalTokens: 2,
        },
        stopReason: "stop",
        timestamp: 1767225601000,
      },
    }),
  ];
  writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf-8");

  const registry = [
    {
      id: SESSION_ID,
      mode: "project",
      cwd: PROJECT_CWD,
      title: "E2E 预置会话",
      model: null,
      thinkingLevel: "medium",
      sessionFile,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "e2e-empty-session",
      mode: "chat",
      cwd: "",
      title: "E2E 空会话",
      model: null,
      thinkingLevel: "medium",
      sessionFile: null,
      createdAt: 2,
      updatedAt: 2,
    },
  ];
  writeFileSync(join(home, "sessions.json"), JSON.stringify(registry, null, 2), "utf-8");
}

test.describe("Fork 会话 + 导出上下文", () => {
  test("会话菜单出现 Fork/导出入口；空会话两项禁用", async () => {
    const app = await launchApp({ seed });
    const window = await app.firstWindow();

    // 侧栏出现预置会话（空间分组下）
    const row = window.locator("div.group", { hasText: "E2E 预置会话" }).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.hover();
    await row.getByTitle("会话操作").click();

    // 菜单里 Fork / 导出 / 删除都在，且可用（「删除会话」同时匹配行尾 × 按钮，取首个=菜单项）
    await expect(window.getByRole("button", { name: "Fork 会话", exact: true })).toBeEnabled();
    await expect(window.getByRole("button", { name: "导出会话上下文", exact: true })).toBeEnabled();
    await expect(window.getByRole("button", { name: "删除会话" }).first()).toBeVisible();
    // 点主区域空白处关掉菜单（避免点中侧栏其他会话行误触发切换）
    await window.mouse.click(600, 400);

    // 空会话（无 sessionFile）：Fork/导出禁用、删除可用
    const emptyRow = window.locator("div.group", { hasText: "E2E 空会话" }).first();
    await emptyRow.hover();
    await emptyRow.getByTitle("会话操作").click();
    await expect(window.getByRole("button", { name: "Fork 会话", exact: true })).toBeDisabled();
    await expect(window.getByRole("button", { name: "导出会话上下文", exact: true })).toBeDisabled();
    await expect(window.getByRole("button", { name: "删除会话" }).first()).toBeEnabled();

    await app.close();
  });

  test("导出会话上下文：落盘三件套并给出接力提示词反馈", async () => {
    let home = "";
    const app = await launchApp({
      seed: (h) => {
        home = h;
        seed(h);
      },
    });
    const window = await app.firstWindow();

    const row = window.locator("div.group", { hasText: "E2E 预置会话" }).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.hover();
    await row.getByTitle("会话操作").click();
    await window.getByRole("button", { name: "导出会话上下文", exact: true }).click();

    // UI 反馈先断言：notice 8 秒自动消失，必须在文件检查之前完成
    // （剪贴板在 headless 下可能被拒走 handoff.md 兜底文案，两种都算成功）
    await expect(window.getByText(/接力提示词已复制|提示词已保存/)).toBeVisible({ timeout: 20000 });

    // 导出目录落盘三件套（等三个文件都写完，消除写盘竞态）
    await expect
      .poll(
        () => {
          const dir = join(home, "exports");
          if (!existsSync(dir) || readdirSync(dir).length === 0) return false;
          const first = join(dir, readdirSync(dir)[0]!);
          return ["session.jsonl", "transcript.md", "handoff.md"].every((f) => existsSync(join(first, f)));
        },
        { timeout: 15000 },
      )
      .toBe(true);
    const exportDir = join(home, "exports", readdirSync(join(home, "exports"))[0]!);
    expect(existsSync(join(exportDir, "session.jsonl"))).toBe(true);
    expect(existsSync(join(exportDir, "handoff.md"))).toBe(true);
    const transcript = readFileSync(join(exportDir, "transcript.md"), "utf-8");
    expect(transcript).toContain("你好，帮我看下这个项目");
    expect(transcript).toContain("好的，这是一个 E2E 预置项目。");
    // 接力提示词指路 transcript/JSONL + handoff 指令
    const prompt = readFileSync(join(exportDir, "handoff.md"), "utf-8");
    expect(prompt).toContain(join(exportDir, "transcript.md"));
    expect(prompt).toContain("conversation history that has already taken place");

    await app.close();
  });

  test("Fork 会话：弹窗确认后侧栏出现分叉会话，原会话保留", async () => {
    const app = await launchApp({ seed });
    const window = await app.firstWindow();

    const row = window.locator("div.group", { hasText: "E2E 预置会话" }).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.hover();
    await row.getByTitle("会话操作").click();
    await window.getByRole("button", { name: "Fork 会话", exact: true }).click();

    // ForkDialog 打开：标题默认「<源标题> · 分叉」
    const titleInput = window.locator("input").first();
    await expect(titleInput).toHaveValue("E2E 预置会话 · 分叉");
    // 确认 Fork（宿主走 forkFrom 文件复制 + 无模型 createAgentSession）
    await window.getByRole("button", { name: "Fork", exact: true }).click();

    // 侧栏出现分叉会话，原会话仍在（标题同时出现在侧栏与顶栏面包屑，取首个）
    await expect(window.getByText("E2E 预置会话 · 分叉").first()).toBeVisible({ timeout: 30000 });
    await expect(window.getByText("E2E 预置会话", { exact: true }).first()).toBeVisible();

    await app.close();
  });
});
