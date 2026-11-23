import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type ElectronApplication, expect, test } from "@playwright/test";
import { launchApp } from "./helpers.js";

test("Electron 与浏览器共享 WorkItem；关闭 Electron 后控制面继续服务", async () => {
  const spcodeHome = mkdtempSync(join(tmpdir(), "spcode-control-e2e-"));
  let app: ElectronApplication | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  let servicePid: number | null = null;
  try {
    app = await launchApp({ spcodeHome, controlPlane: true });
    const desktop = await app.firstWindow();
    await expect(desktop.getByTestId("brand")).toBeVisible();
    await desktop.getByTestId("superagent-nav").click();
    await expect(desktop.getByTestId("superagent-page")).toBeVisible();
    await desktop.getByLabel("标题", { exact: true }).fill("跨端权威状态验收");
    await desktop.getByLabel("需求", { exact: true }).fill("关闭 Electron 后由浏览器恢复");
    await desktop.getByTestId("create-workitem").click();
    await expect(desktop.getByText("跨端权威状态验收", { exact: true }).last()).toBeVisible();

    const runtime = JSON.parse(readFileSync(join(spcodeHome, "superagent", "runtime.json"), "utf8")) as {
      pid: number;
      port: number;
    };
    servicePid = runtime.pid;
    const deviceToken = readFileSync(join(spcodeHome, "superagent", "device-token"), "utf8").trim();
    await app.close();
    app = null;

    const health = await fetch(`http://127.0.0.1:${runtime.port}/api/v1/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).pid).toBe(runtime.pid);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${runtime.port}/?view=superagent#bootstrap=${deviceToken}`);
    await expect(page.getByTestId("superagent-page")).toBeVisible();
    await expect(page.getByText("跨端权威状态验收", { exact: true }).last()).toBeVisible();
    await expect(page.getByText("计划中", { exact: true }).first()).toBeVisible();
  } finally {
    await app?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (servicePid) {
      try {
        process.kill(servicePid, "SIGTERM");
      } catch {
        // 服务已退出时无需重复清理。
      }
    }
    rmSync(spcodeHome, { recursive: true, force: true });
  }
});
