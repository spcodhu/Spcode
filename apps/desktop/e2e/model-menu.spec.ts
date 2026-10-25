import { expect, type Page, test } from "@playwright/test";
import { launchApp } from "./helpers";

/** 配置两个本地假密钥即可看到模型目录，不会发起真实模型请求。 */
async function configureProvider(window: Page, name: string) {
  await window.getByRole("button", { name: `配置 ${name}`, exact: true }).click();
  await window.locator('input[type="password"]').fill("sk-e2e-model-menu");
  await window.getByRole("button", { name: "保存", exact: true }).click();
  await window.getByRole("button", { name: "返回", exact: true }).click();
}

test("模型菜单：按供应商分组、键盘导航、选中定位与焦点归还", async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await window.getByRole("button", { name: /新建聊天/ }).click();
  await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });
  await window.getByTitle("设置", { exact: true }).click();
  await window.getByRole("button", { name: "模型", exact: true }).click();
  await configureProvider(window, "DeepSeek");
  await configureProvider(window, "Kimi For Coding");
  await window.getByTitle("关闭设置").click();

  const trigger = window.getByTestId("composer-model-menu");
  await trigger.click();
  await window.getByTestId("composer-open-models").click();

  const options = window.getByTestId("composer-model-option");
  await expect(options.first()).toBeVisible();
  expect(await options.count()).toBeGreaterThan(2);
  const providers = await options.evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute("data-provider")))]);
  await expect(window.getByTestId("composer-model-provider")).toHaveCount(providers.length);
  expect(providers).toContain("deepseek");
  expect(providers).toContain("kimi-coding");

  // 打开时聚焦第一项，方向键循环，Home/End 可直接到首尾。
  await expect(options.first()).toBeFocused();
  await window.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toBeFocused();
  await window.keyboard.press("End");
  await expect(options.last()).toBeFocused();
  await window.keyboard.press("Home");
  await expect(options.first()).toBeFocused();

  // 选择后关闭并归还焦点；重开时当前项有稳定的选中语义和背景。
  const selectedId = await options.first().getAttribute("data-model");
  const selectedProvider = await options.first().getAttribute("data-provider");
  await options.first().click();
  await expect(window.getByRole("dialog", { name: "模型", exact: true })).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await window.getByTestId("composer-open-models").click();
  const selected = window.locator(
    `[data-testid="composer-model-option"][data-provider="${selectedProvider}"][data-model="${selectedId}"]`,
  );
  await expect(selected).toHaveAttribute("aria-selected", "true");
  await expect(selected).toHaveClass(/bg-accent-soft/);
  await expect(selected).toBeFocused();

  // Esc 先返回主菜单，再关闭最上层弹层，不影响底层会话。
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("composer-open-models")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(window.getByRole("dialog", { name: "模型", exact: true })).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await app.close();
});
