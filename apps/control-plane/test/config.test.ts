import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.js";
import { ControlPlane } from "../src/server.js";
import { NodeWorkerRunner } from "../src/worker-runner.js";

const root = dirname(fileURLToPath(import.meta.url));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("SuperAgent 配置与生命周期", () => {
  it("sanitize、脱敏与跨重启持久化", () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-config-test-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    process.env.SPCODE_GITHUB_TOKEN = "github-secret-value";
    process.env.SPCODE_FEISHU_APP_SECRET = "feishu-secret-value";
    const config = new ConfigStore(home);
    config.set({
      enabled: true,
      concurrency: 99,
      timezone: "Not/A_Real_Timezone",
      defaultRepo: "spcodhu/Spcode",
      digestChatId: "chat-1",
      repositories: [
        { repo: "owner/repo", localPath: "/repo", chatId: "chat-1", defaultBranch: "main", labels: ["agent"] },
      ],
      model: { provider: "moonshot", modelId: "kimi" },
    });
    const raw = readFileSync(join(home, "config.json"), "utf8");
    expect(raw).not.toContain("github-secret-value");
    expect(raw).not.toContain("feishu-secret-value");
    const reopened = new ConfigStore(home).get();
    expect(reopened.concurrency).toBe(2);
    expect(reopened.timezone).toBe("Asia/Shanghai");
    expect(reopened.repositories[0]?.labels).toEqual(["agent"]);
    expect(reopened.model).toEqual({ provider: "moonshot", modelId: "kimi" });
    delete process.env.SPCODE_GITHUB_TOKEN;
    delete process.env.SPCODE_FEISHU_APP_SECRET;
  });

  it("API 热启用后自动计划，热禁用后不再派工", async () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-config-live-"));
    const repo = join(home, "repo");
    const workbenchDir = join(home, "workbench");
    mkdirSync(workbenchDir, { recursive: true });
    writeFileSync(join(workbenchDir, "index.html"), "<title>Spcode</title>");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
    const plane = new ControlPlane({
      baseDir: home,
      spcodeHome: home,
      workbenchDir,
      port: 0,
      resolveRepoPath: () => repo,
      workerRunner: new NodeWorkerRunner(home, resolve(root, "../src/fake-worker.ts"), { SPCODE_HOME: home }),
      workerPollMs: 20,
      digestSchedulerEnabled: false,
    });
    cleanups.push(async () => {
      await plane.close().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    });
    const { port, deviceToken } = await plane.start();
    const origin = `http://127.0.0.1:${port}`;
    const bootstrap = await fetch(`${origin}/api/v1/auth/bootstrap`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        Origin: origin,
        "X-Spcode-Control-Client": "1",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    const command = (body: unknown) =>
      fetch(`${origin}/api/v1/superagent/commands`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "X-Spcode-Control-Client": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const enabled = await command({ type: "config.update", patch: { enabled: true, concurrency: 1 } });
    expect(enabled.status).toBe(200);
    expect((await enabled.json()).enabled).toBe(true);
    await command({
      type: "workitem.create",
      requestId: "req_hot_enable",
      repo: "owner/repo",
      title: "热启用",
      request: "自动计划",
    });
    const deadline = Date.now() + 8000;
    for (;;) {
      const response = await fetch(`${origin}/api/v1/superagent/snapshot`, { headers: { Cookie: cookie } });
      const state = await response.json();
      if (state.workItems[0]?.status === "AWAITING_PLAN_APPROVAL") break;
      if (Date.now() > deadline) throw new Error("热启用后未自动计划");
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    }
    const disabled = await command({ type: "config.update", patch: { enabled: false } });
    expect((await disabled.json()).enabled).toBe(false);
    await command({
      type: "workitem.create",
      requestId: "req_hot_disable",
      repo: "owner/repo",
      title: "热禁用",
      request: "不得派工",
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    const state = await (await fetch(`${origin}/api/v1/superagent/snapshot`, { headers: { Cookie: cookie } })).json();
    expect(state.workItems.find((item: { title: string }) => item.title === "热禁用").status).toBe("PLANNING");
    expect(state.workItems.find((item: { title: string }) => item.title === "热禁用").activeAttemptId).toBeNull();
    expect(
      state.attempts.every(
        (attempt: { workItemId: string }) =>
          attempt.workItemId !== state.workItems.find((item: { title: string }) => item.title === "热禁用").id,
      ),
    ).toBe(true);
  });
});
