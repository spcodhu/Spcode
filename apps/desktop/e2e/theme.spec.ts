import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

test("暗色自定义主题使用完整暗色兜底，首页与侧栏不再半亮半暗", async () => {
  const app = await launchApp({
    seed(home) {
      writeFileSync(
        join(home, "settings.json"),
        JSON.stringify({
          themeId: "spcode-light",
          customTheme: {
            name: "局部暗色",
            base: "dark",
            colors: { bgRoot: "#111114", bgMain: "#202024" },
          },
        }),
      );
    },
  });
  const window = await app.firstWindow();
  await expect(window.getByTestId("brand")).toBeVisible({ timeout: 15000 });

  const tokens = await window.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      main: style.getPropertyValue("--color-bg-main").trim(),
      sidebar: style.getPropertyValue("--color-bg-sidebar").trim(),
      bubble: style.getPropertyValue("--color-user-bubble").trim(),
      base: document.documentElement.dataset.themeBase,
    };
  });
  expect(tokens).toEqual({ main: "#202024", sidebar: "#161618", bubble: "#28282D", base: "dark" });
  await expect(window.getByTestId("sidebar-panel")).toHaveCSS("background-color", "rgb(22, 22, 24)");
  await expect(window.getByTestId("brand")).toHaveCSS("color", "rgb(240, 240, 242)");

  await expect(window.getByRole("button", { name: /仅对话，不绑定文件夹/ })).toBeVisible();
  await expect(window.getByRole("button", { name: /选择文件夹开始工作/ })).toBeVisible();
  await app.close();
});
