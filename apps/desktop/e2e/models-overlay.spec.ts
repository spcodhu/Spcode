import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

/**
 * 自定义模型 E2E：任意 provider 手动添加模型 ID → 自定义标签 → 删除闭环。
 * 覆盖 pi 引擎目录滞后（新模型发布到上游收录可能相隔数周）场景：
 * 用户无需手改配置文件，设置页填写模型 ID 即可用上新模型（此处以 k3.1-pro 为例）。
 * 断言锚 role/placeholder/aria-label，不绑展示文案以外的结构。
 */
test.describe("自定义供应商 E2E", () => {
  test("新增 Pi 目录外供应商 → 添加模型 → 编辑端点与协议 → 删除闭环", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();
    window.on("dialog", (d) => void d.accept());

    await window.getByRole("button", { name: /新建聊天/ }).click();
    await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });
    await window.getByTitle("设置", { exact: true }).click();
    await window.getByRole("button", { name: "模型", exact: true }).click();

    await window.getByTestId("models-add-provider").click();
    await expect(window.getByTestId("provider-form-modal")).toBeVisible();
    await window.getByTestId("provider-id-input").fill("acme-ai");
    await window.getByTestId("provider-name-input").fill("Acme AI");
    await window.getByTestId("provider-base-url-input").fill("https://api.acme.test/v1");
    await window.getByTestId("provider-api-key-input").fill("test-key");
    await window.getByTestId("provider-save").click();

    await expect(window.getByRole("heading", { name: "Acme AI", exact: true })).toBeVisible({ timeout: 15000 });
    await window.getByPlaceholder(/gpt-5\.2/).fill("acme-chat");
    await window.getByPlaceholder("262144").fill("128000");
    const addForm = window.getByTestId("custom-model-add-form");
    await addForm.getByTestId("custom-model-system-role-select").click();
    await addForm.locator('[role="option"][data-value="system"]').click();
    await window.getByRole("button", { name: "添加", exact: true }).click();
    await expect(window.getByText("acme-chat", { exact: true })).toBeVisible({ timeout: 15000 });

    // 模型级角色配置持久化：system → developer → auto，每次均从 Host 目录重新回填
    const editModel = window.locator('[data-testid="model-edit"][data-model="acme-ai/acme-chat"]');
    await editModel.click();
    let modelForm = window.getByTestId("custom-model-edit-form");
    await expect(modelForm.getByTestId("custom-model-system-role-select")).toHaveAttribute("data-value", "system");
    await modelForm.getByTestId("custom-model-system-role-select").click();
    await modelForm.locator('[role="option"][data-value="developer"]').click();
    await modelForm.getByTestId("custom-model-submit").click();
    await editModel.click();
    modelForm = window.getByTestId("custom-model-edit-form");
    await expect(modelForm.getByTestId("custom-model-system-role-select")).toHaveAttribute("data-value", "developer");
    await modelForm.getByTestId("custom-model-system-role-select").click();
    await modelForm.locator('[role="option"][data-value="auto"]').click();
    await modelForm.getByTestId("custom-model-submit").click();
    await editModel.click();
    modelForm = window.getByTestId("custom-model-edit-form");
    await expect(modelForm.getByTestId("custom-model-system-role-select")).toHaveAttribute("data-value", "auto");
    await modelForm.getByRole("button", { name: "取消", exact: true }).click();

    await window.getByTestId("provider-edit").click();
    await expect(window.getByTestId("provider-id-input")).toBeDisabled();
    await window.getByTestId("provider-name-input").fill("Acme Updated");
    await window.getByTestId("provider-base-url-input").fill("http://localhost:4000/v1");
    await window.getByTestId("provider-api-select").click();
    await window.getByRole("option", { name: "openai-responses", exact: true }).click();
    await window.getByTestId("provider-save").click();
    await expect(window.getByRole("heading", { name: "Acme Updated", exact: true })).toBeVisible({ timeout: 15000 });
    await expect(window.getByText("acme-chat", { exact: true })).toBeVisible();

    await window.getByTestId("provider-delete").click();
    await expect(window.getByRole("button", { name: "配置 Acme Updated", exact: true })).toHaveCount(0, {
      timeout: 15000,
    });
    await app.close();
  });
});

test.describe("内置供应商配置删除 E2E", () => {
  test("删除本地密钥后移出已配置分组，目录保留可重新配置", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();
    window.on("dialog", (dialog) => void dialog.accept());

    await window.getByRole("button", { name: /新建聊天/ }).click();
    await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });
    await window.getByTitle("设置", { exact: true }).click();
    await window.getByRole("button", { name: "模型", exact: true }).click();
    await window.getByRole("button", { name: "配置 DeepSeek", exact: true }).click();
    await window.locator('input[type="password"]').fill("sk-e2e-remove-provider");
    await window.getByRole("button", { name: "保存", exact: true }).click();

    await expect(window.getByTestId("provider-delete")).toBeVisible({ timeout: 15000 });
    await window.getByTestId("provider-delete").click();
    await expect(
      window.getByTestId("configured-providers").locator('[data-testid="provider-row"][data-provider="deepseek"]'),
    ).toHaveCount(0, { timeout: 15000 });
    await expect(
      window.getByTestId("unconfigured-providers").locator('[data-testid="provider-row"][data-provider="deepseek"]'),
    ).toBeVisible();
    await app.close();
  });
});

test.describe("自定义模型 E2E", () => {
  test("添加自定义模型后可再次编辑并持久化全部字段，删除与内置模型保护仍生效", async () => {
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

    // 行内编辑入口：回填已有配置，ID 固定，其余字段均可修改
    const editButton = window.locator('[data-testid="model-edit"][data-model="kimi-coding/k3.1-pro"]');
    await expect(editButton).toBeVisible();
    await editButton.click();
    let form = window.getByTestId("custom-model-edit-form");
    await expect(form.getByTestId("custom-model-id-input")).toHaveValue("k3.1-pro");
    await expect(form.getByTestId("custom-model-id-input")).toBeDisabled();
    await expect(form.getByTestId("custom-model-context-input")).toHaveValue("262144");
    await expect(form.getByTestId("custom-model-max-tokens-input")).toHaveValue("131072");
    await form.getByTestId("custom-model-name-input").fill("k3.1-pro-renamed");
    await form.getByTestId("custom-model-context-input").fill("128000");
    await form.getByTestId("custom-model-max-tokens-input").fill("8192");
    await form.getByRole("switch", { name: "推理模型", exact: true }).click();
    await form.getByRole("switch", { name: "支持视觉", exact: true }).click();
    await form.getByTestId("custom-model-submit").click();
    await expect(window.getByText("k3.1-pro-renamed", { exact: true })).toBeVisible({ timeout: 15000 });

    // 再次打开验证不是只改了展示层：目录返回值已持久化全部编辑字段
    await editButton.click();
    form = window.getByTestId("custom-model-edit-form");
    await expect(form.getByTestId("custom-model-name-input")).toHaveValue("k3.1-pro-renamed");
    await expect(form.getByTestId("custom-model-context-input")).toHaveValue("128000");
    await expect(form.getByTestId("custom-model-max-tokens-input")).toHaveValue("8192");
    await expect(form.getByRole("switch", { name: "推理模型", exact: true })).toHaveAttribute("aria-checked", "false");
    await expect(form.getByRole("switch", { name: "支持视觉", exact: true })).toHaveAttribute("aria-checked", "true");
    await form.getByRole("button", { name: "取消", exact: true }).click();

    // 删除：确认后行消失
    await window.getByRole("button", { name: "删除 k3.1-pro-renamed" }).click();
    await expect(window.locator('[data-testid="model-edit"][data-model="kimi-coding/k3.1-pro"]')).toHaveCount(0, {
      timeout: 15000,
    });

    // 内置模型不可删：Kimi K3 行内没有删除按钮（同容器内断言）
    const builtinRow = window.getByText("Kimi K3", { exact: true }).locator("..");
    await expect(builtinRow.getByRole("button", { name: /^删除 / })).toHaveCount(0);

    await app.close();
  });
});

test.describe("在线模型发现 E2E", () => {
  test("本地 OpenAI 列表 → 预览选择 → 批量导入与回填；错误脱敏且不覆盖已有模型", async () => {
    let failDiscovery = false;
    const requests: { path: string; authorization: string | null }[] = [];
    const server = createServer((request, response) => {
      requests.push({ path: request.url ?? "", authorization: request.headers.authorization ?? null });
      if (failDiscovery) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "invalid test-key" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "remote-chat", name: "Remote Chat", status: "online" },
            { id: "deepseek/deepseek-flash", name: "DeepSeek Flash", status: "online" },
            { id: "existing-chat", status: "online" },
            { id: "offline-model", status: "offline" },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    let app: Awaited<ReturnType<typeof launchApp>> | undefined;
    try {
      app = await launchApp();
      const window = await app.firstWindow();
      await window.getByRole("button", { name: /新建聊天/ }).click();
      await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });
      await window.getByTitle("设置", { exact: true }).click();
      await window.getByRole("button", { name: "模型", exact: true }).click();
      await window.getByTestId("models-add-provider").click();
      await window.getByTestId("provider-id-input").fill("discovery-ai");
      await window.getByTestId("provider-name-input").fill("Discovery AI");
      await window.getByTestId("provider-base-url-input").fill(baseUrl);
      await window.getByTestId("provider-api-key-input").fill("test-key");
      await window.getByTestId("provider-save").click();
      await expect(window.getByRole("heading", { name: "Discovery AI", exact: true })).toBeVisible({ timeout: 15000 });

      // 已有模型用于证明在线导入只跳过，不覆盖上下文、最大输出与角色配置。
      const addForm = window.getByTestId("custom-model-add-form");
      await addForm.getByTestId("custom-model-id-input").fill("existing-chat");
      await addForm.getByTestId("custom-model-context-input").fill("128000");
      await addForm.getByTestId("custom-model-submit").click();
      await expect(window.locator('[data-testid="model-edit"][data-model="discovery-ai/existing-chat"]')).toBeVisible();

      await window.getByTestId("models-discover").click();
      const modal = window.getByTestId("model-discovery-modal");
      const remoteCheckbox = modal.locator('[data-testid="discovered-model-checkbox"][data-model="remote-chat"]');
      await expect(remoteCheckbox).toBeVisible({ timeout: 15000 });
      await expect(
        modal.locator('[data-testid="discovered-model-checkbox"][data-model="existing-chat"]'),
      ).toBeDisabled();
      await expect(modal.locator('[data-testid="discovered-model-checkbox"][data-model="offline-model"]')).toHaveCount(
        0,
      );
      await modal.getByTestId("model-discovery-search").fill("deepseek");
      await expect(remoteCheckbox).toHaveCount(0);
      await expect(
        modal.locator('[data-testid="discovered-model-checkbox"][data-model="deepseek/deepseek-flash"]'),
      ).toBeVisible();
      await modal.getByTestId("model-discovery-search").fill("");
      await remoteCheckbox.check();
      await modal.locator('[data-testid="discovered-model-checkbox"][data-model="deepseek/deepseek-flash"]').check();
      await modal.getByTestId("discovery-default-context").fill("64000");
      await modal.getByTestId("discovery-default-max-tokens").fill("8192");
      await modal.getByRole("switch", { name: "推理模型", exact: true }).click();
      await modal.getByRole("switch", { name: "支持视觉", exact: true }).click();
      await modal.getByTestId("discovery-default-role").click();
      await modal.locator('[role="option"][data-value="system"]').click();
      await modal.getByTestId("models-import-selected").click();
      await expect(modal.getByTestId("model-discovery-import-result")).toBeVisible({ timeout: 15000 });
      await modal.getByTestId("model-discovery-close").click();

      const remoteEdit = window.locator('[data-testid="model-edit"][data-model="discovery-ai/remote-chat"]');
      await expect(remoteEdit).toBeVisible();
      await expect(
        window.locator('[data-testid="model-edit"][data-model="discovery-ai/deepseek/deepseek-flash"]'),
      ).toBeVisible();
      await remoteEdit.click();
      let form = window.getByTestId("custom-model-edit-form");
      await expect(form.getByTestId("custom-model-context-input")).toHaveValue("64000");
      await expect(form.getByTestId("custom-model-max-tokens-input")).toHaveValue("8192");
      await expect(form.getByRole("switch", { name: "推理模型", exact: true })).toHaveAttribute("aria-checked", "true");
      await expect(form.getByRole("switch", { name: "支持视觉", exact: true })).toHaveAttribute("aria-checked", "true");
      await expect(form.getByTestId("custom-model-system-role-select")).toHaveAttribute("data-value", "system");
      await form.getByRole("button", { name: "取消", exact: true }).click();

      const existingEdit = window.locator('[data-testid="model-edit"][data-model="discovery-ai/existing-chat"]');
      await existingEdit.click();
      form = window.getByTestId("custom-model-edit-form");
      await expect(form.getByTestId("custom-model-context-input")).toHaveValue("128000");
      await expect(form.getByTestId("custom-model-max-tokens-input")).toHaveValue("131072");
      await expect(form.getByTestId("custom-model-system-role-select")).toHaveAttribute("data-value", "auto");
      await form.getByRole("button", { name: "取消", exact: true }).click();
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((request) => request.path === "/v1/models")).toBe(true);
      expect(requests.every((request) => request.authorization === "Bearer test-key")).toBe(true);

      failDiscovery = true;
      await window.getByTestId("models-discover").click();
      const errorAlert = window.getByTestId("model-discovery-modal").getByRole("alert");
      await expect(errorAlert).toBeVisible({ timeout: 15000 });
      await expect(errorAlert).toContainText("401");
      await expect(errorAlert).not.toContainText("test-key");
      await window.getByTestId("model-discovery-close").click();
      await expect(existingEdit).toBeVisible();

      // 无统一列表语义的协议明确禁用入口，不发伪协议请求。
      await window.getByTestId("provider-edit").click();
      await window.getByTestId("provider-api-select").click();
      await window.locator('[role="option"][data-value="bedrock-converse-stream"]').click();
      await window.getByTestId("provider-save").click();
      await expect(window.getByTestId("models-discover")).toBeDisabled();
    } finally {
      if (app) await app.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
