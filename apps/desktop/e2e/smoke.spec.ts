import { test, expect, _electron as electron } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test.describe("Spcode 冒烟 E2E", () => {
  test("启动 → 首页 → 新建聊天 → 输入框就绪", async () => {
    const app = await electron.launch({ args: [".", "--no-sandbox"], cwd: appDir });
    const window = await app.firstWindow();

    // 首页品牌区
    await expect(window.getByText("Spcode").first()).toBeVisible({ timeout: 15000 });

    // 新建聊天（注意：侧边栏提示文本也含"新建聊天"，必须按 role 选按钮）
    await window.getByRole("button", { name: /新建聊天/ }).click();

    // 输入框出现，空会话提示出现
    await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });
    await expect(window.getByText("开始对话吧")).toBeVisible();

    await app.close();
  });

  test("侧边栏会话列表 + 设置面板开合", async () => {
    const app = await electron.launch({ args: [".", "--no-sandbox"], cwd: appDir });
    const window = await app.firstWindow();

    await window.getByRole("button", { name: /新建聊天/ }).click();
    await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });

    // 侧边栏出现会话条目（默认标题"新聊天"）
    await expect(window.getByText("新聊天").first()).toBeVisible();

    // 打开设置：出现 API Key 区块与配额区块
    await window.getByText("⚙️ 设置").click();
    await expect(window.getByText("模型供应商 API Key")).toBeVisible();
    await expect(window.getByText("厂商配额")).toBeVisible();
    await expect(window.getByText(/Token 用量/)).toBeVisible();

    // 关闭设置（✕ 有多处，限定在设置对话框内）
    const dialog = window.locator(".fixed.inset-0.z-40");
    await dialog.getByText("✕").click();
    await expect(window.getByText("模型供应商 API Key")).not.toBeVisible();

    await app.close();
  });

  test("无模型时发消息不会导致崩溃", async () => {
    const app = await electron.launch({ args: [".", "--no-sandbox"], cwd: appDir });
    const window = await app.firstWindow();

    await window.getByRole("button", { name: /新建聊天/ }).click();
    const composer = window.getByPlaceholder(/说点什么/);
    await expect(composer).toBeVisible({ timeout: 15000 });

    await composer.fill("你好");
    await composer.press("Enter");

    // 用户消息上屏；界面不崩（输入框仍在）
    await expect(window.getByText("你好").first()).toBeVisible();
    await expect(composer).toBeVisible();

    await app.close();
  });
});
