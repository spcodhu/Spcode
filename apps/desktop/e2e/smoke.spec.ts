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
    await expect(window.getByText("上下文用量环")).toBeVisible();

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

  test("会话搜索：Cmd+K 与侧栏按钮开合，输入出结果区", async () => {
    const app = await electron.launch({ args: [".", "--no-sandbox"], cwd: appDir });
    const window = await app.firstWindow();
    await expect(window.getByText("Spcode").first()).toBeVisible({ timeout: 15000 });

    // Cmd+K 打开
    await window.keyboard.press("Meta+KeyK");
    const input = window.getByPlaceholder(/搜索会话标题与正文/);
    await expect(input).toBeVisible({ timeout: 5000 });

    // 输入查询出现结果区（无匹配时显示空态）
    await input.fill("不存在的关键词xyz");
    await expect(window.getByText("没有匹配的会话")).toBeVisible({ timeout: 5000 });

    // Esc 关闭
    await window.keyboard.press("Escape");
    await expect(input).not.toBeVisible();

    // 侧栏搜索按钮打开
    await window.getByTitle("搜索会话（Cmd+K）").click();
    await expect(window.getByPlaceholder(/搜索会话标题与正文/)).toBeVisible({ timeout: 5000 });
    await window.keyboard.press("Escape");

    await app.close();
  });

  test("定时任务：面板开合 + 创建/删除任务闭环", async () => {
    const app = await electron.launch({ args: [".", "--no-sandbox"], cwd: appDir });
    const window = await app.firstWindow();
    await expect(window.getByText("Spcode").first()).toBeVisible({ timeout: 15000 });

    // 唯一任务名：与历史残留/并行运行隔离
    const taskName = `E2E任务${Date.now() % 100000}`;

    // 侧栏时钟按钮打开面板
    await window.getByTitle("定时任务").click();
    await expect(window.getByRole("button", { name: /新建任务/ })).toBeVisible({ timeout: 5000 });

    // 打开表单并填写
    await window.getByRole("button", { name: /新建任务/ }).click();
    await window.getByPlaceholder("如：每日晨报").fill(taskName);
    await window.getByPlaceholder(/汇总我昨天的用量/).fill("说一句你好");

    // 默认每天 09:00，直接创建
    await window.getByRole("button", { name: "创建任务" }).click();

    // 列表出现任务行（作用域锁定到本任务，避免同名残留干扰）
    const row = window.locator("div.rounded-xl", { hasText: taskName }).first();
    await expect(row).toBeVisible({ timeout: 5000 });
    await expect(row.getByText(/每天 09:00/)).toBeVisible();

    // 删除（两段确认）清理现场
    await row.getByTitle("删除", { exact: true }).click();
    await row.getByText("确认删除？").click();
    await expect(window.getByText(taskName)).not.toBeVisible();

    await app.close();
  });
});
