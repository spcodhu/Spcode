import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

/**
 * 自定义模型 E2E：任意 provider 手动添加模型 ID → 自定义标签 → 删除闭环。
 * 覆盖 pi 引擎目录滞后（新模型发布到上游收录可能相隔数周）场景：
 * 用户无需手改配置文件，设置页填写模型 ID 即可用上新模型（此处以 k3.1-pro 为例）。
 * 断言锚 role/placeholder/aria-label，不绑展示文案以外的结构。
 */
test.describe("自定义模型 E2E", () => {
  test("打开供应商详情 → 手动添加 k3.1-pro → 自定义标签与删除 → 删除生效；内置模型不可删", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();
    window.on("dialog", (d) => void d.accept());

    await window.getByRole("button", { name: /新建聊天/ }).click();
    await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });

    await window.getByTitle("设置", { exact: true }).click();
    await window.getByRole("button", { name: "模型", exact: true }).click();

    // 打开 Kimi For Coding 详情
    const openBtn = window.getByRole("button", { name: "配置 Kimi For Coding", exact: true });
    await expect(openBtn).toBeVisible({ timeout: 30000 });
    await openBtn.click();

    // 手动添加模型（通用表单：模型 ID / 显示名 / 上下文 / 推理 / 视觉自由配置）
    await window.getByPlaceholder(/gpt-5\.2/).fill("k3.1-pro");
    await window.getByPlaceholder("262144").fill("262144");
    await window.getByRole("button", { name: "添加", exact: true }).click();
    await expect(window.getByText("k3.1-pro", { exact: true })).toBeVisible({ timeout: 15000 });
    // 自定义标签区分 pi 官方目录模型与用户手动添加
    await expect(window.getByText("自定义").first()).toBeVisible();

    // 删除：确认后行消失
    await window.getByRole("button", { name: "删除 k3.1-pro" }).click();
    await expect(window.getByText("k3.1-pro", { exact: true })).toHaveCount(0, { timeout: 15000 });

    // 内置模型不可删：Kimi K3 行内没有删除按钮（同容器内断言）
    const builtinRow = window.getByText("Kimi K3", { exact: true }).locator("..");
    await expect(builtinRow.getByRole("button", { name: /^删除 / })).toHaveCount(0);

    await app.close();
  });
});
