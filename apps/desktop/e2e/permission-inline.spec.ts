import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { launchApp } from "./helpers";

async function createChat(window: Page, text: string): Promise<string> {
  const input = window.getByTestId("composer-input");
  await input.fill(text);
  await input.press("Enter");
  await expect(window.getByText(text, { exact: true }).first()).toBeVisible();
  const sessions = await window.evaluate(() => window.spcode.listSessions());
  const session = sessions.find((s) => s.title === text);
  expect(session).toBeDefined();
  return session!.id;
}

async function emitPermission(
  app: ElectronApplication,
  input: { requestId: string; sessionId: string; command: string },
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, request) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("spcode:host-event", {
      type: "permission.request",
      request: {
        requestId: request.requestId,
        sessionId: request.sessionId,
        toolName: "bash",
        args: { command: request.command },
        risk: "write",
        cwd: "/tmp/e2e-project",
      },
    });
  }, input);
}

test("权限卡按会话隔离，完整长命令换行且无水平滚动", async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByRole("button", { name: /新建聊天/ }).click();
  const firstTitle = "权限会话甲";
  const firstSession = await createChat(window, firstTitle);

  await window.getByTestId("sidebar-new-chat").click();
  const secondTitle = "权限会话乙";
  const secondSession = await createChat(window, secondTitle);

  const longCommand = `pnpm test --flag=${"x".repeat(1800)}\n&& pnpm build`;
  await emitPermission(app, { requestId: "permission-first", sessionId: firstSession, command: longCommand });
  await emitPermission(app, { requestId: "permission-second", sessionId: secondSession, command: "pnpm test" });

  // 当前在会话乙：只能看到乙的请求，会话甲通过侧栏提示，不弹全局框。
  await expect(window.getByTestId("permission-command")).toHaveText("pnpm test");
  await expect(window.getByRole("alertdialog")).toHaveCount(0);
  const firstRow = window.locator("aside").getByTitle(firstTitle, { exact: true });
  await expect(firstRow.getByTestId("sidebar-permission-waiting")).toBeVisible();

  await firstRow.click();
  const command = window.getByTestId("permission-command");
  await expect(command).toHaveText(longCommand);
  const metrics = await command.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    overflowX: getComputedStyle(el).overflowX,
    whiteSpace: getComputedStyle(el).whiteSpace,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.overflowX).toBe("hidden");
  expect(metrics.whiteSpace).toBe("pre-wrap");

  await app.close();
});
