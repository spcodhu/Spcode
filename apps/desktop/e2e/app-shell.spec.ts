/**
 * 应用外壳 E2E：启动、设置入口、搜索/定时任务、权限模式、语言持久化。
 *
 * E2E 只保留必须真跑 Electron 的断言（主进程窗口行为、真实落盘与跨重启、
 * 整棵渲染树的联动），纯展示/纯计算逻辑一律由 test/*.test.ts 覆盖。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { launchApp } from "./helpers";

async function chooseLanguage(page: Page, locale: "zh-CN" | "en") {
  const group = page.getByTestId("settings-language");
  await group.getByRole("button").click();
  const label = locale === "en" ? /English|英语/ : /简体中文|Simplified Chinese/;
  await group.getByRole("option", { name: label }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
}

test("启动就绪：后台窗口、首页与新建聊天、无模型发送不崩溃", async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  // 后台模式：窗口不显示、不抢焦点，但仍可被 Playwright 驱动
  const windowState = await app.evaluate(({ app, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return { visible: win?.isVisible(), focused: win?.isFocused(), active: app.isActive() };
  });
  expect(windowState.visible).toBe(false);
  expect(windowState.focused).toBe(false);
  expect(windowState.active).toBe(false);

  await expect(window.getByTestId("brand")).toBeVisible({ timeout: 15000 });

  // 新建聊天（侧栏提示文本也含「新建聊天」，必须按 role 选按钮）
  await window.getByRole("button", { name: /新建聊天/ }).click();
  const composer = window.getByPlaceholder(/说点什么/);
  await expect(composer).toBeVisible({ timeout: 15000 });
  await expect(window.getByTestId("empty-state")).toBeVisible();
  // 沙盒状态不再占用输入框工具栏（开关在设置页）
  await expect(window.getByTestId("sandbox-status-chip")).toHaveCount(0);

  // 无模型时发送不崩溃：用户消息上屏，输入框仍在
  await composer.fill("你好");
  await composer.press("Enter");
  await expect(window.getByText("你好").first()).toBeVisible();
  await expect(composer).toBeVisible();

  await app.close();
});

test("设置入口：导航各页面、快捷键开合与用量骨架", async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await window.getByRole("button", { name: /新建聊天/ }).click();
  await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });

  // 底部齿轮打开设置，默认落在通用页
  await window.getByTitle("设置", { exact: true }).click();
  await expect(window.getByRole("button", { name: "用量" })).toBeVisible();
  await expect(window.getByRole("button", { name: "配额" })).toBeVisible();
  await expect(window.getByRole("button", { name: "记忆" })).toBeVisible();
  await expect(window.getByRole("heading", { name: "通用" })).toBeVisible();

  // 用量页：无数据也要渲染骨架，区间切换后图表仍在
  await window.getByRole("button", { name: "用量" }).click();
  await expect(window.getByTestId("usage-trend")).toBeVisible();
  await expect(window.getByTestId("usage-heatmap")).toBeVisible();
  await expect(window.getByTestId("usage-streak-longest")).toBeVisible();
  await window.getByRole("button", { name: "最近 30 天" }).click();
  await expect(window.getByTestId("usage-trend-chart")).toBeVisible();

  await window.getByRole("button", { name: "配额" }).click();
  await expect(window.getByText("上下文用量环")).toBeVisible();

  await window.getByRole("button", { name: "模型", exact: true }).click();
  await expect(window.getByText(/配置模型提供商和可用模型/)).toBeVisible();

  await window.getByTitle("关闭设置").click();
  await expect(window.getByRole("button", { name: "用量" })).not.toBeVisible();

  // Cmd+, 打开；ESC 关闭；再开后点遮罩关闭
  await window.keyboard.press("Meta+Comma");
  await expect(window.getByRole("button", { name: "用量" })).toBeVisible({ timeout: 5000 });
  await window.keyboard.press("Escape");
  await expect(window.getByRole("button", { name: "用量" })).not.toBeVisible();
  await window.keyboard.press("Meta+Comma");
  await expect(window.getByRole("button", { name: "用量" })).toBeVisible({ timeout: 5000 });
  await window.mouse.click(30, 30);
  await expect(window.getByRole("button", { name: "用量" })).not.toBeVisible();

  await app.close();
});

test("会话搜索与定时任务：快捷键开合、创建与删除闭环", async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByTestId("brand")).toBeVisible({ timeout: 15000 });

  // Cmd+K 打开，输入出现结果区（无匹配时显示空态），Esc 关闭
  await window.keyboard.press("Meta+KeyK");
  const input = window.getByPlaceholder(/搜索会话标题与正文/);
  await expect(input).toBeVisible({ timeout: 5000 });
  await input.fill("不存在的关键词xyz");
  await expect(window.getByText("没有匹配的会话")).toBeVisible({ timeout: 5000 });
  await window.keyboard.press("Escape");
  await expect(input).not.toBeVisible();
  await window.getByTitle("搜索会话（Cmd+K）").click();
  await expect(window.getByPlaceholder(/搜索会话标题与正文/)).toBeVisible({ timeout: 5000 });
  await window.keyboard.press("Escape");

  // 定时任务：唯一任务名，避免历史残留干扰
  const taskName = `E2E任务${Date.now() % 100000}`;
  await window.getByTitle("定时任务").click();
  await expect(window.getByRole("button", { name: /新建任务/ })).toBeVisible({ timeout: 5000 });
  await window.getByRole("button", { name: /新建任务/ }).click();
  await window.getByPlaceholder("如：每日晨报").fill(taskName);
  await window.getByPlaceholder(/汇总我昨天的用量/).fill("说一句你好");
  await window.getByRole("button", { name: "创建任务" }).click();

  const row = window.locator("div.rounded-xl", { hasText: taskName }).first();
  await expect(row).toBeVisible({ timeout: 5000 });
  await expect(row.getByText(/每天 09:00/)).toBeVisible();
  await row.getByTitle("删除", { exact: true }).click();
  await row.getByText("确认删除？").click();
  await expect(window.getByText(taskName)).not.toBeVisible();

  await app.close();
});

test("权限模式：三档循环、总不询问二次确认与新会话默认", async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await window.getByRole("button", { name: /新建聊天/ }).click();
  const pill = window.getByTestId("composer-permission-mode");
  await expect(pill).toHaveAttribute("data-mode", "ask", { timeout: 15000 });

  // 菜单三项都在，当前项标记选中
  await pill.click();
  await expect(window.getByTestId("permission-mode-menu")).toBeVisible();
  for (const mode of ["ask", "auto", "never"]) {
    await expect(window.getByTestId(`permission-mode-option-${mode}`)).toBeVisible();
  }
  await expect(window.getByTestId("permission-mode-option-ask")).toHaveAttribute("aria-checked", "true");

  await window.getByTestId("permission-mode-option-auto").click();
  await expect(pill).toHaveAttribute("data-mode", "auto");
  await expect(window.getByTestId("permission-mode-confirm")).toHaveCount(0);

  // 「总不询问」必须过二次确认；取消保持原档
  await pill.click();
  await window.getByTestId("permission-mode-option-never").click();
  await expect(window.getByTestId("permission-mode-confirm")).toBeVisible();
  await window.getByTestId("permission-mode-confirm-cancel").click();
  await expect(pill).toHaveAttribute("data-mode", "auto");
  await pill.click();
  await window.getByTestId("permission-mode-option-never").click();
  await window.getByTestId("permission-mode-confirm-ok").click();
  await expect(pill).toHaveAttribute("data-mode", "never");

  // 输入框内 Shift+Tab 循环：never → ask
  const input = window.getByPlaceholder(/说点什么/);
  await input.click();
  await input.press("Shift+Tab");
  await expect(pill).toHaveAttribute("data-mode", "ask");

  // 设置页：权限模式是「新会话默认」，与关闭沙盒叠加时出现红字警示
  await window.getByTitle("设置", { exact: true }).click();
  await window.getByRole("button", { name: "通用" }).click();
  const group = window.getByTestId("settings-permission-mode");
  await expect(group).toBeVisible();
  for (const label of ["总是询问", "必要时询问", "总不询问"]) {
    await expect(group.getByRole("button", { name: new RegExp(label) })).toBeVisible();
  }
  await expect(group.getByRole("button", { name: /总是询问/ })).toHaveClass(/border-accent/);
  await group.getByRole("button", { name: /总不询问/ }).click();
  await expect(group.getByRole("button", { name: /总不询问/ })).toHaveClass(/border-accent/);
  const sandboxToggle = window.getByTestId("sandbox-settings").getByRole("switch", { name: "启用命令沙盒" });
  await sandboxToggle.click();
  await expect(window.getByTestId("sandbox-disabled-mode-warning")).toBeVisible();
  await sandboxToggle.click();
  await expect(window.getByTestId("sandbox-disabled-mode-warning")).toHaveCount(0);

  await app.close();
});

test("语言切换：全部设置页即时切换并在重启后保持", async () => {
  const home = mkdtempSync(join(tmpdir(), "spcode-locale-e2e-"));
  let app = await launchApp({ spcodeHome: home });
  try {
    let page = await app.firstWindow();
    await expect(page.getByTestId("brand")).toBeVisible({ timeout: 15000 });
    await page.keyboard.press("Meta+Comma");
    await chooseLanguage(page, "en");
    for (const section of ["general", "appearance", "models", "usage", "quota", "remote", "mcp", "memory", "about"]) {
      await page.getByTestId(`settings-nav-${section}`).click();
      await expect(page.locator("body")).not.toContainText(/[\u4e00-\u9fff]/);
    }
    await page.keyboard.press("Escape");
    await expect(page.locator("body")).not.toContainText(/[\u4e00-\u9fff]/);
    await app.close();

    // 重启后仍是英文；切回中文后设置导航立即回中文
    app = await launchApp({ spcodeHome: home });
    page = await app.firstWindow();
    await expect(page.getByTestId("brand")).toBeVisible({ timeout: 15000 });
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.keyboard.press("Meta+Comma");
    await chooseLanguage(page, "zh-CN");
    await expect(page.getByTestId("settings-nav-general")).toHaveText("通用");
    await expect(page.getByTestId("settings-language").getByRole("button").first()).toHaveText("简体中文");
  } finally {
    // 正常路径已在上面关闭；异常路径兜底
    await app.close().catch(() => {});
  }
});
