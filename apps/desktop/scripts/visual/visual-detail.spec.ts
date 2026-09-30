/** 视觉验证（细节版）：模型菜单弹层 / 模型设置页 / 空间菜单 */
import { test, _electron as electron } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const shotDir = join(appDir, "test-results", "visual");

test("细节截图", async () => {
  test.setTimeout(90000);
  const app = await electron.launch({ args: [".", "--no-sandbox"], cwd: appDir });
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1280, height: 840 });
  await window.waitForTimeout(1500);

  await window.getByRole("button", { name: /新建聊天/ }).click();
  await window.getByPlaceholder(/说点什么/).waitFor({ timeout: 15000 });

  // 模型菜单弹层
  const pill = window.getByRole("button", { name: /选择模型/ });
  await pill.click();
  await window.waitForTimeout(400);
  await window.screenshot({ path: join(shotDir, "04-model-menu.png"), clip: { x: 700, y: 380, width: 580, height: 460 } });
  await window.keyboard.press("Escape");
  await window.getByPlaceholder(/说点什么/).click();

  // 设置 → 模型页
  await window.getByTitle("设置", { exact: true }).click();
  await window.getByRole("button", { name: "模型", exact: true }).click();
  await window.waitForTimeout(600);
  await window.screenshot({ path: join(shotDir, "05-models-page.png") });

  await app.close();
});
