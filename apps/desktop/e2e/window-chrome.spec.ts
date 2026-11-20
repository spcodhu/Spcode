import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

type OverlayCall = { color?: string; symbolColor?: string; height?: number };
type OverlayTestGlobal = typeof globalThis & { __spcodeOverlayCalls?: OverlayCall[] };

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

  // 回归截图：工作区开关与缓存/计费框都不能伸进最小化、最大化、关闭按钮区域。
  await window.getByTestId("sidebar-new-chat").click();
  const usageChip = window.getByTestId("session-usage-chip");
  await expect(usageChip).toBeVisible();
  // 用应用实际预留窗口按钮区的同一 CSS env 探测覆盖层左边界（Electron 各版本
  // navigator.windowControlsOverlay 的 JS API 不一致，env(titlebar-area-width) 稳定）。
  // Windows titlebar-area-x=0，覆盖层左边界即 titlebar-area-width。
  const overlayLeft = await window.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;left:0;height:0;visibility:hidden;width:env(titlebar-area-width,100vw);";
    document.body.appendChild(probe);
    const left = probe.getBoundingClientRect().width;
    probe.remove();
    return left;
  });
  expect(overlayLeft).toBeGreaterThan(0);
  for (const testId of ["workspace-panel-toggle", "session-usage-chip"]) {
    const box = await window.getByTestId(testId).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(overlayLeft!);
  }

  // 工作区展开后，系统按钮覆盖的是右侧工作区顶栏，关闭按钮同样必须避开。
  await window.getByTestId("workspace-panel-toggle").click();
  const closeButton = window.getByTestId("workspace-panel-close");
  await expect(closeButton).toBeVisible();
  const closeBox = await closeButton.boundingBox();
  expect(closeBox).not.toBeNull();
  expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(overlayLeft!);
  await app.close();
});

test("Windows 设置遮罩同步原生窗口按钮配色", async () => {
  test.skip(process.platform !== "win32", "原生窗口按钮配色仅在 Windows 验收");
  const app = await launchApp();
  const window = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const original = win.setTitleBarOverlay.bind(win);
    const calls: OverlayCall[] = [];
    (globalThis as OverlayTestGlobal).__spcodeOverlayCalls = calls;
    win.setTitleBarOverlay = (options) => {
      calls.push({ ...options });
      original(options);
    };
  });

  await window.getByTestId("sidebar-settings").click();
  await expect
    .poll(() => app.evaluate(() => (globalThis as OverlayTestGlobal).__spcodeOverlayCalls?.at(-1)?.color))
    .toBe("#737373");
  await expect
    .poll(() => app.evaluate(() => (globalThis as OverlayTestGlobal).__spcodeOverlayCalls?.at(-1)?.symbolColor))
    .toBe("#FFFFFF");

  await window.keyboard.press("Escape");
  await expect
    .poll(() => app.evaluate(() => (globalThis as OverlayTestGlobal).__spcodeOverlayCalls?.at(-1)?.color))
    .toBe("#FFFFFF");
  await app.close();
});

test("Windows 点关闭后需确认，可取消、最小化继续运行或完全退出", async () => {
  test.skip(process.platform !== "win32", "窗口关闭确认仅在 Windows 验收");
  const app = await launchApp();
  const window = await app.firstWindow();
  // 等 React 挂载 onWindowCloseRequested 监听器后再触发关闭，避免慢启动 CI 竞态丢 IPC
  await expect(window.getByTestId("brand")).toBeVisible({ timeout: 15000 });
  const closeWindow = () =>
    app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.close();
    });

  await closeWindow();
  await expect(window.getByTestId("window-close-dialog")).toBeVisible();
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isDestroyed())).toBe(false);
  await window.getByTestId("window-close-cancel").click();
  await expect(window.getByTestId("window-close-dialog")).toHaveCount(0);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())).toBe(false);

  await closeWindow();
  await window.getByTestId("window-close-minimize").click();
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized()))
    .toBe(true);
  // 窗口最小化后渲染进程与主进程都保持存活，未走 before-quit 的宿主清理。
  await expect(window.getByTestId("brand")).toBeVisible();
  expect(app.process().exitCode).toBeNull();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.restore());

  await closeWindow();
  const exited = new Promise<number | null>((resolve) => app.process().once("exit", (code) => resolve(code)));
  // quit 会立即退出进程，click 的动作后校验会撞上 browser closed；dispatchEvent 触发后直接等退出
  await window.getByTestId("window-close-quit").dispatchEvent("click");
  expect(await exited).toBe(0);
});
