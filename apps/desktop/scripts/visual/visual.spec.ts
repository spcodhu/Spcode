/** 视觉验证：截取用量页/配额页/主界面三张图，供与原图比对 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, test } from "@playwright/test";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const shotDir = join(appDir, "test-results", "visual");

test("视觉截图", async () => {
  test.setTimeout(90000);
  const app = await electron.launch({
    args: [".", "--no-sandbox"],
    cwd: appDir,
  });
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1280, height: 840 });
  await window.waitForTimeout(2000);

  // 主界面（先建一个聊天，带一条用户消息）
  await window.getByRole("button", { name: /新建聊天/ }).click();
  const composer = window.getByPlaceholder(/说点什么/);
  await composer.waitFor({ timeout: 15000 });
  await composer.fill("你这个页面设计的真是一言难尽，请参照 Finch 重做");
  await window.waitForTimeout(300);
  await window.screenshot({ path: join(shotDir, "01-main.png") });

  // 设置 → 用量
  await window.getByTitle("设置", { exact: true }).click();
  await window.getByRole("button", { name: "用量" }).waitFor();
  await window.waitForTimeout(600);
  await window.screenshot({ path: join(shotDir, "02-usage.png") });

  // 设置 → 配额
  await window.getByRole("button", { name: "配额" }).click();
  await window.waitForTimeout(800);
  await window.screenshot({ path: join(shotDir, "03-quota.png") });

  await app.close();
});
