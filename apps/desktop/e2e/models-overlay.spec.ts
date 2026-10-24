import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

/**
 * 模型目录 overlay E2E：官方补丁标签 + 添加/删除自定义模型。
 * 覆盖 pi 引擎目录滞后（K3.1 未收录）场景下的用户零操作路径与自定义逃生舱。
 * 断言锚 role/placeholder/aria-label，不绑展示文案以外的结构。
 */
test.describe("模型目录 overlay E2E", () => {
  test("官方补丁标签可见（Kimi Code 目录含 K3.1）→ 添加自定义模型 → 自定义标签与删除 → 删除生效", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();
    window.on("dialog", (d) => void d.accept());

    await window.getByRole("button", { name: /新建聊天/ }).click();
    await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });

    await window.getByTitle("设置", { exact: true }).click();
    await window.getByRole("button", { name: "模型", exact: true }).click();

    // 打开 Kimi For Coding 详情（官方补丁注入的供应商）
    const openBtn = window.getByRole("button", { name: "配置 Kimi For Coding", exact: true });
    await expect(openBtn).toBeVisible({ timeout: 30000 });
    await openBtn.click();

    // 官方补丁：上游 pi-ai 0.87.1~1.4.0 均未收录 K3.1，补丁必须出现在目录里
    await expect(window.getByText("Kimi K3.1 Pro", { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(window.getByText("官方补丁").first()).toBeVisible();

    // 添加自定义模型（placeholder 锚点，不依赖展示文案结构）
    await window.getByPlaceholder(/k3\.1-pro/).fill("e2e-test-model");
    await window.getByRole("button", { name: "添加", exact: true }).click();
    await expect(window.getByText("e2e-test-model")).toBeVisible({ timeout: 15000 });
    await expect(window.getByText("自定义").first()).toBeVisible();

    // 删除：仅自定义模型有删除按钮；确认后行消失
    await window.getByRole("button", { name: "删除 e2e-test-model" }).click();
    await expect(window.getByText("e2e-test-model")).toHaveCount(0, { timeout: 15000 });

    // 官方补丁模型不可删：K3.1 行内没有删除按钮（同容器内断言）
    const patchRow = window.getByText("Kimi K3.1 Pro", { exact: true }).locator("..");
    await expect(patchRow.getByRole("button", { name: /^删除 / })).toHaveCount(0);

    await app.close();
  });
});
