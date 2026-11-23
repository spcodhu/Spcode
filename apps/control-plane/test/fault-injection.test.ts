import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const children = new Set<ChildProcess>();
const homes: string[] = [];
const root = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function gitRepo(home: string): string {
  const repo = join(home, "repo");
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

async function startService(home: string, repo: string, port: number, extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, [resolve(root, "../dist/index.mjs")], {
    env: {
      ...process.env,
      SPCODE_HOME: home,
      SPCODE_WORKBENCH_DIR: join(home, "workbench"),
      SPCODE_CONTROL_PORT: String(port),
      SPCODE_SUPERAGENT_ENABLED: "1",
      SPCODE_SUPERAGENT_REPO_PATH: repo,
      SPCODE_SUPERAGENT_FAKE_WORKER: "1",
      SPCODE_WATCHDOG: "0",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (data) => console.log(`[fault-service] ${String(data).trim()}`));
  child.stderr?.on("data", (data) => console.error(`[fault-service] ${String(data).trim()}`));
  children.add(child);
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const response = await fetch(`${origin}/api/v1/health`);
      if (response.ok) break;
    } catch {
      // 等待监听。
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("控制面启动超时");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  }
  return { child, origin };
}

async function bootstrap(origin: string, home: string): Promise<string> {
  const deviceToken = readFileSync(join(home, "superagent", "device-token"), "utf8").trim();
  const response = await fetch(`${origin}/api/v1/auth/bootstrap`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deviceToken}`,
      Origin: origin,
      "X-Spcode-Control-Client": "1",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

async function command(origin: string, cookie: string, body: unknown): Promise<void> {
  const response = await fetch(`${origin}/api/v1/superagent/commands`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: origin,
      "X-Spcode-Control-Client": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
}

async function snapshot(origin: string, cookie: string): Promise<any> {
  const response = await fetch(`${origin}/api/v1/superagent/snapshot`, { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  return response.json();
}

async function waitStatus(origin: string, cookie: string, status: string): Promise<any> {
  const deadline = Date.now() + 12_000;
  for (;;) {
    const state = await snapshot(origin, cookie);
    if (state.workItems[0]?.status === status) return state;
    if (Date.now() > deadline) throw new Error(`等待 ${status} 超时：${JSON.stringify(state.workItems)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  }
}

function approve(origin: string, cookie: string, state: any): Promise<void> {
  const item = state.workItems[0];
  const plan = state.plans[0];
  return command(origin, cookie, {
    type: "plan.approve",
    workItemId: item.id,
    planId: plan.id,
    planHash: plan.planHash,
  });
}

describe("真实进程强杀恢复", () => {
  it("批准落库后/派工前强杀，重启只执行一次", async () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-fault-approval-"));
    homes.push(home);
    const repo = gitRepo(home);
    const port = await freePort();
    const first = await startService(home, repo, port, { SPCODE_WORKER_POLL_MS: "100000" });
    const cookie = await bootstrap(first.origin, home);
    await command(first.origin, cookie, {
      type: "workitem.create",
      requestId: "req_fault_approval",
      repo: "spcodhu/Spcode",
      title: "批准断点",
      request: "批准后强杀",
    });
    await approve(first.origin, cookie, await waitStatus(first.origin, cookie, "AWAITING_PLAN_APPROVAL"));
    first.child.kill("SIGKILL");
    const second = await startService(home, repo, port, { SPCODE_WORKER_POLL_MS: "20" });
    const completed = await waitStatus(second.origin, cookie, "COMPLETED");
    const item = completed.workItems[0];
    expect(item.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(
      execFileSync("git", ["rev-list", "--count", `${item.baseSha}..HEAD`], {
        cwd: item.worktreePath,
        encoding: "utf8",
      }).trim(),
    ).toBe("1");
    expect(completed.attempts.filter((attempt: { role: string }) => attempt.role === "execute")).toHaveLength(1);
    second.child.kill("SIGTERM");
  }, 30_000);

  it("commit 后/回执前强杀，恢复只登记实际 commit", async () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-fault-commit-"));
    homes.push(home);
    const repo = gitRepo(home);
    const port = await freePort();
    const first = await startService(home, repo, port, { SPCODE_WORKER_POLL_MS: "20", SPCODE_TEST_AFTER_COMMIT: "1" });
    const cookie = await bootstrap(first.origin, home);
    await command(first.origin, cookie, {
      type: "workitem.create",
      requestId: "req_fault_commit",
      repo: "spcodhu/Spcode",
      title: "commit 断点",
      request: "commit 后强杀",
    });
    await approve(first.origin, cookie, await waitStatus(first.origin, cookie, "AWAITING_PLAN_APPROVAL"));
    const committing = await waitStatus(first.origin, cookie, "COMMITTING");
    const before = committing.workItems[0];
    const commitDeadline = Date.now() + 5000;
    let sha = "";
    while (Date.now() < commitDeadline) {
      sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: before.worktreePath, encoding: "utf8" }).trim();
      if (sha !== before.baseSha) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    expect(sha).not.toBe(before.baseSha);
    first.child.kill("SIGKILL");
    const second = await startService(home, repo, port, { SPCODE_WORKER_POLL_MS: "20" });
    const completed = await waitStatus(second.origin, cookie, "COMPLETED");
    const item = completed.workItems[0];
    expect(item.commitSha).toBe(sha);
    expect(
      execFileSync("git", ["rev-list", "--count", `${item.baseSha}..HEAD`], {
        cwd: item.worktreePath,
        encoding: "utf8",
      }).trim(),
    ).toBe("1");
    expect(completed.attempts.filter((attempt: { role: string }) => attempt.role === "execute")).toHaveLength(1);
    second.child.kill("SIGTERM");
  }, 30_000);
});
