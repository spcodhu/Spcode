import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { ControlPlane } from "../../control-plane/src/server.js";

const root = dirname(fileURLToPath(import.meta.url));

test("浏览器与 SQLite 控制面完成创建、计划审批与刷新恢复", async ({ page }) => {
  const home = mkdtempSync(join(tmpdir(), "spcode-workbench-e2e-"));
  const plane = new ControlPlane({
    baseDir: home,
    workbenchDir: resolve(root, "../dist"),
    port: 0,
  });
  const { port, deviceToken } = await plane.start();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${port}/?view=superagent#bootstrap=${deviceToken}`);
    await expect(page.getByTestId("superagent-page")).toBeVisible();
    await expect(page.getByTestId("create-workitem")).toBeVisible();
    await expect(page).toHaveURL(/^(?!.*bootstrap=)/);

    await page.getByLabel("标题", { exact: true }).fill("浏览器持久化验收");
    await page.getByLabel("需求", { exact: true }).fill("创建计划、批准并验证刷新恢复");
    await page.getByTestId("create-workitem").click();
    await expect(page.getByText("浏览器持久化验收", { exact: true }).last()).toBeVisible();

    await page.getByLabel("计划内容", { exact: true }).fill("# 目标\n\n验证统一工作台。\n\n# 验证\n\npnpm test");
    await page.getByLabel("baseSha", { exact: true }).fill("a8ad263");
    await page.getByTestId("submit-plan").click();
    await expect(page.getByTestId("approve-plan")).toBeVisible();
    await page.getByTestId("approve-plan").click();
    await expect(page.getByText("已排队", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("执行事实已落库。", { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByText("浏览器持久化验收", { exact: true }).last()).toBeVisible();
    await expect(page.getByText("已排队", { exact: true }).first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await plane.close();
    rmSync(home, { recursive: true, force: true });
  }
});
