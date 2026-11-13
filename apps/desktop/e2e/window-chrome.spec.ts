import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

test("macOS 全屏时取消红绿灯留白，退出后恢复", async () => {
  test.skip(process.platform !== "darwin", "原生红绿灯行为仅在 macOS 验收");
  const app = await launchApp();
  const window = await app.firstWindow();
  const header = window.getByTestId("sidebar-titlebar");
  await expect(header).toHaveAttribute("data-platform", "darwin", { timeout: 15000 });
  await expect(header).toHaveAttribute("data-fullscreen", "false");
  expect(await header.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe("80px");
  expect((await window.getByTestId("sidebar-home").boundingBox())?.x).toBe(80);

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setFullScreen(true);
  });
  await expect(header).toHaveAttribute("data-fullscreen", "true", { timeout: 15000 });
  expect(await header.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe("12px");
  expect((await window.getByTestId("sidebar-home").boundingBox())?.x).toBe(12);

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setFullScreen(false);
  });
  await expect(header).toHaveAttribute("data-fullscreen", "false", { timeout: 15000 });
  expect(await header.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe("80px");
  await app.close();
});

test("Windows 顶栏融合窗口按钮且不显示原生菜单", async () => {
  test.skip(process.platform !== "win32", "窗口控制按钮覆盖层仅在 Windows 验收");
  const app = await launchApp();
  const window = await app.firstWindow();
  const header = window.getByTestId("main-titlebar");
  await expect(window.getByTestId("sidebar-titlebar")).toHaveAttribute("data-platform", "win32", { timeout: 15000 });

  const menuVisible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMenuBarVisible());
  expect(menuVisible).toBe(false);
  await expect
    .poll(() =>
      window.evaluate(
        () =>
          (navigator as Navigator & { windowControlsOverlay?: { visible: boolean } }).windowControlsOverlay?.visible ===
          true,
      ),
    )
    .toBe(true);
  expect(Number.parseFloat(await header.evaluate((el) => getComputedStyle(el).paddingRight))).toBeGreaterThan(100);
  await app.close();
});
