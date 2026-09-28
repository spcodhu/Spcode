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

  test("设置页：导航开合与各页面", async () => {
    const app = await electron.launch({ args: [".", "--no-sandbox"], cwd: appDir });
    const window = await app.firstWindow();

    await window.getByRole("button", { name: /新建聊天/ }).click();
    await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });

    // 打开设置（底部齿轮）
    await window.getByTitle("设置", { exact: true }).click();
    await expect(window.getByRole("button", { name: "用量" })).toBeVisible();
    await expect(window.getByRole("button", { name: "配额" })).toBeVisible();
    await expect(window.getByRole("button", { name: "记忆" })).toBeVisible();

    // 默认落在用量页
    await expect(window.getByRole("heading", { name: "用量" })).toBeVisible();

    // 切到配额页
    await window.getByRole("button", { name: "配额" }).click();
    await expect(window.getByText("快捷展示配额")).toBeVisible();

    // 切到模型页
    await window.getByRole("button", { name: "模型", exact: true }).click();
    await expect(window.getByText(/配置模型提供商和可用模型/)).toBeVisible();

    // 关闭设置
    await window.getByTitle("关闭设置").click();
    await expect(window.getByRole("button", { name: "用量" })).not.toBeVisible();

    await app.close();
  });

  test("快捷键 Cmd+, 开设置，ESC 与点击外部关闭", async () => {
    const app = await electron.launch({ args: [".", "--no-sandbox"], cwd: appDir });
    const window = await app.firstWindow();

    await window.getByRole("button", { name: /新建聊天/ }).click();
    await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });

    // Cmd+, 打开设置（macOS）
    await window.keyboard.press("Meta+Comma");
    await expect(window.getByRole("button", { name: "用量" })).toBeVisible({ timeout: 5000 });

    // ESC 关闭
    await window.keyboard.press("Escape");
    await expect(window.getByRole("button", { name: "用量" })).not.toBeVisible();

    // 再开，点面板外部任意位置关闭
    await window.keyboard.press("Meta+Comma");
    await expect(window.getByRole("button", { name: "用量" })).toBeVisible({ timeout: 5000 });
    // 点左上角空白处（遮罩层）
    await window.mouse.click(30, 30);
    await expect(window.getByRole("button", { name: "用量" })).not.toBeVisible();

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
