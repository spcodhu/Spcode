/** Switch 组件视觉验证：模型页(全关态) + 配额页(开启态) */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, test } from "@playwright/test";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const shotDir = join(appDir, "test-results", "visual");

test("开关截图", async () => {
  test.setTimeout(90000);
  const app = await electron.launch({ args: [".", "--no-sandbox"], cwd: appDir });
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1280, height: 840 });
  await window.waitForTimeout(1500);

  await window.getByRole("button", { name: /新建聊天/ }).click();
  await window.getByPlaceholder(/说点什么/).waitFor({ timeout: 15000 });
  await window.getByTitle("设置", { exact: true }).click();

  // 模型页：未配置密钥全关态
  await window.getByRole("button", { name: "模型", exact: true }).click();
  await window.waitForTimeout(600);
  await window.screenshot({
    path: join(shotDir, "06-switch-off.png"),
    clip: { x: 330, y: 180, width: 820, height: 320 },
  });

  // 配额页：快捷展示配额开启态
  await window.getByRole("button", { name: "配额" }).click();
  await window.waitForTimeout(600);
  await window.screenshot({
    path: join(shotDir, "07-switch-on.png"),
    clip: { x: 330, y: 60, width: 820, height: 180 },
  });

  await app.close();
});
