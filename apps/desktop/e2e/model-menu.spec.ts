import { expect, type Page, test } from "@playwright/test";
import { launchApp } from "./helpers";

/** 配置两个本地假密钥即可看到模型目录，不会发起真实模型请求。 */
async function configureProvider(window: Page, name: string) {
  await window.getByRole("button", { name: `配置 ${name}`, exact: true }).click();
  await window.locator('input[type="password"]').fill("sk-e2e-model-menu");
  await window.getByRole("button", { name: "保存", exact: true }).click();
  await window.getByRole("button", { name: "返回", exact: true }).click();
}

test("模型菜单：按供应商分组、搜索过滤、键盘导航、选中定位与焦点归还", async () => {
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
  const totalCount = await options.count();
  expect(totalCount).toBeGreaterThan(2);
  const providers = await options.evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute("data-provider")))]);
  await expect(window.getByTestId("composer-model-provider")).toHaveCount(providers.length);
  expect(providers).toContain("deepseek");
  expect(providers).toContain("kimi-coding");

  // 面向 OpenRouter 等几百个模型的中转站：打开时默认聚焦搜索框，可直接打字过滤。
  const search = window.getByTestId("composer-model-search");
  await expect(search).toBeFocused();
  await search.fill("kimi");
  await expect(options.first()).toBeVisible();
  const kimiCount = await options.count();
  expect(kimiCount).toBeGreaterThan(0);
  expect(kimiCount).toBeLessThan(totalCount);
  const kimiProviders = await options.evaluateAll((els) => [
    ...new Set(els.map((el) => el.getAttribute("data-provider"))),
  ]);
  expect(kimiProviders).toEqual(["kimi-coding"]);
  await search.fill("不存在的模型名字");
  await expect(window.getByTestId("composer-model-search-empty")).toBeVisible();
  await search.fill("");

  // 清空后恢复全量，方向键从搜索框直接跳进列表第一项，再循环/Home/End。
  await expect(options).toHaveCount(totalCount);
  await window.keyboard.press("ArrowDown");
  await expect(options.first()).toBeFocused();
  await window.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toBeFocused();
  await window.keyboard.press("End");
  await expect(options.last()).toBeFocused();
  await window.keyboard.press("Home");
  await expect(options.first()).toBeFocused();

  // 选择后关闭并归还焦点；重开时默认回到搜索框，当前项仍有稳定的选中语义和背景。
  const selectedId = await options.first().getAttribute("data-model");
  const selectedProvider = await options.first().getAttribute("data-provider");
  await options.first().click();
  await expect(window.getByRole("dialog", { name: "模型", exact: true })).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await window.getByTestId("composer-open-models").click();
  await expect(search).toBeFocused();
  const selected = window.locator(
    `[data-testid="composer-model-option"][data-provider="${selectedProvider}"][data-model="${selectedId}"]`,
  );
  await expect(selected).toHaveAttribute("aria-selected", "true");
  await expect(selected).toHaveClass(/bg-accent-soft/);

  // Esc 先返回主菜单，再关闭最上层弹层，不影响底层会话。
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("composer-open-models")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(window.getByRole("dialog", { name: "模型", exact: true })).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await app.close();
});

test("模型菜单：连续停用多个模型后全部隐藏，保留仍启用的模型", async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await window.getByRole("button", { name: /新建聊天/ }).click();
  await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });
  await window.getByTitle("设置", { exact: true }).click();
  await window.getByRole("button", { name: "模型", exact: true }).click();
  await configureProvider(window, "Kimi For Coding");
  await window.getByRole("button", { name: "配置 Kimi For Coding", exact: true }).click();

  const toggles = window.getByTestId("model-enabled-toggle");
  await expect(toggles.nth(2)).toBeVisible({ timeout: 15000 });
  const disabledIds = [
    (await toggles.nth(0).getAttribute("data-model"))!.slice("kimi-coding/".length),
    (await toggles.nth(1).getAttribute("data-model"))!.slice("kimi-coding/".length),
  ];
  const enabledId = (await toggles.nth(2).getAttribute("data-model"))!.slice("kimi-coding/".length);

  // 不等待第一轮保存返回就连续点击，覆盖 disabledModels 旧闭包相互覆盖的竞态。
  await toggles.nth(0).click();
  await toggles.nth(1).click();
  await expect(toggles.nth(0)).toHaveAttribute("aria-pressed", "false");
  await expect(toggles.nth(1)).toHaveAttribute("aria-pressed", "false");
  await window.getByRole("button", { name: "返回", exact: true }).click();
  await window.getByTitle("关闭设置").click();

  await window.getByTestId("composer-model-menu").click();
  await window.getByTestId("composer-open-models").click();
  for (const modelId of disabledIds) {
    await expect(
      window.locator(`[data-testid="composer-model-option"][data-provider="kimi-coding"][data-model="${modelId}"]`),
    ).toHaveCount(0);
  }
  await expect(
    window.locator(`[data-testid="composer-model-option"][data-provider="kimi-coding"][data-model="${enabledId}"]`),
  ).toHaveCount(1);
  await app.close();
});

test("供应商模型批量操作：全部取消启用后从会话消失，全部启用后恢复", async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await window.getByRole("button", { name: /新建聊天/ }).click();
  await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });
  await window.getByTitle("设置", { exact: true }).click();
  await window.getByRole("button", { name: "模型", exact: true }).click();
  await configureProvider(window, "Kimi For Coding");
  await window.getByRole("button", { name: "配置 Kimi For Coding", exact: true }).click();

  const toggles = window.getByTestId("model-enabled-toggle");
  await expect(toggles.first()).toBeVisible({ timeout: 15000 });
  const totalCount = await toggles.count();
  await expect(window.getByTestId("models-enable-all")).toBeDisabled();

  await window.getByTestId("models-disable-all").click();
  await expect
    .poll(
      async () => await toggles.evaluateAll((els) => els.every((el) => el.getAttribute("aria-pressed") === "false")),
    )
    .toBe(true);
  await window.getByRole("button", { name: "返回", exact: true }).click();
  await window.getByTitle("关闭设置").click();

  await window.getByTestId("composer-model-menu").click();
  await window.getByTestId("composer-open-models").click();
  await expect(window.locator('[data-testid="composer-model-option"][data-provider="kimi-coding"]')).toHaveCount(0);
  await window.keyboard.press("Escape");
  await window.keyboard.press("Escape");

  await window.getByTitle("设置", { exact: true }).click();
  await window.getByRole("button", { name: "模型", exact: true }).click();
  await window.getByRole("button", { name: "配置 Kimi For Coding", exact: true }).click();
  await window.getByTestId("models-enable-all").click();
  await expect
    .poll(async () => await toggles.evaluateAll((els) => els.every((el) => el.getAttribute("aria-pressed") === "true")))
    .toBe(true);
  await window.getByRole("button", { name: "返回", exact: true }).click();
  await window.getByTitle("关闭设置").click();

  await window.getByTestId("composer-model-menu").click();
  await window.getByTestId("composer-open-models").click();
  await expect(window.locator('[data-testid="composer-model-option"][data-provider="kimi-coding"]')).toHaveCount(
    totalCount,
  );
  await app.close();
});
