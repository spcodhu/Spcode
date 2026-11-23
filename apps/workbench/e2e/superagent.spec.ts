import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { ControlPlane } from "../../control-plane/src/server.js";
import { FakeGitHub } from "../../control-plane/src/sources/github.js";
import { NodeWorkerRunner } from "../../control-plane/src/worker-runner.js";

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

test("真实 UI 完成自动 Worker、Artifact、Issue 摘要与设置闭环", async ({ page }) => {
  const home = mkdtempSync(join(tmpdir(), "spcode-workbench-full-"));
  const repo = join(home, "repo");
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
  const github = new FakeGitHub([
    {
      id: "issue-7",
      number: 7,
      title: "浏览器 Issue 验收",
      body: "从摘要生成 Trigger",
      author: "octocat",
      labels: ["agent"],
      url: "https://github.com/owner/repo/issues/7",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      contentHash: "v1",
    },
  ]);
  const plane = new ControlPlane({
    baseDir: home,
    spcodeHome: home,
    workbenchDir: resolve(root, "../dist"),
    port: 0,
    superAgentEnabled: true,
    resolveRepoPath: () => repo,
    workerRunner: new NodeWorkerRunner(home, resolve(root, "../../control-plane/src/fake-worker.ts"), {
      SPCODE_HOME: home,
    }),
    workerPollMs: 20,
    githubConnector: github,
    digestChatId: "chat-1",
    digestSchedulerEnabled: false,
  });
  const { port, deviceToken } = await plane.start();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${port}/?view=superagent#bootstrap=${deviceToken}`);
    await page.getByLabel("标题", { exact: true }).fill("自动 Worker 验收");
    await page.getByLabel("需求", { exact: true }).fill("自动计划、执行并保存产物");
    await page.getByTestId("create-workitem").click();
    await expect(page.getByTestId("approve-plan")).toBeVisible();
    await page.getByTestId("approve-plan").click();
    await expect(page.getByText("执行结果", { exact: true })).toBeVisible();
    await expect(page.getByText("下载 diff", { exact: true })).toBeVisible();
    const diffHref = await page.getByText("下载 diff", { exact: true }).getAttribute("href");
    expect(diffHref).toBeTruthy();
    const diffResponse = await page.request.get(new URL(diffHref!, page.url()).href);
    expect(diffResponse.status()).toBe(200);
    expect(await diffResponse.text()).toContain("superagent-result.md");
    await expect(page.getByText("下载完整计划", { exact: true })).toBeVisible();

    await page.getByTestId("superagent-tab-digest").click();
    await page.getByTestId("run-digest").click();
    await expect(page.getByTestId("approve-issue-7")).toBeVisible();
    await page.getByTestId("approve-issue-7").click();
    await page.getByTestId("superagent-tab-work").click();
    await page.getByRole("button", { name: /Issue #7 浏览器 Issue 验收/ }).click();
    await expect(page.getByTestId("approve-plan")).toBeVisible();
    await page.getByTestId("approve-plan").click();
    await expect(page.getByText("执行结果", { exact: true })).toBeVisible();

    await page.getByTestId("superagent-tab-settings").click();
    const concurrency = page.getByLabel("Worker 全局并发（1–8）", { exact: true });
    await concurrency.fill("1");
    await page.getByTestId("save-superagent-config").click();
    await expect(concurrency).toHaveValue("1");
    await page.reload();
    await page.getByTestId("superagent-tab-settings").click();
    await expect(page.getByLabel("Worker 全局并发（1–8）", { exact: true })).toHaveValue("1");
    expect(errors).toEqual([]);
  } finally {
    await plane.close();
    rmSync(home, { recursive: true, force: true });
  }
});
