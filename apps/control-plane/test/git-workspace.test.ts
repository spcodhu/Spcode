import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitWorkspaceManager, workerEnvironment } from "../src/git-workspace.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "spcode-git-workspace-"));
  const repo = join(root, "user-checkout");
  const manager = new GitWorkspaceManager(join(root, "managed"), () => repo);
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, repo, manager };
}

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("GitWorkspaceManager 真实 Git 隔离", () => {
  it("两个 WorkItem 并行 commit，不触碰用户脏 checkout", async () => {
    const { repo, manager } = await fixture();
    writeFileSync(join(repo, "user-untracked.txt"), "用户未提交内容\n");
    const originalHead = git(repo, ["rev-parse", "HEAD"]);
    const originalStatus = git(repo, ["status", "--porcelain"]);
    const first = await manager.prepare("wi_first", "owner/repo");
    const second = await manager.prepare("wi_second", "owner/repo");
    expect(first.worktreePath).not.toBe(second.worktreePath);
    expect(first.branch).toBe("superagent/wi_first");
    expect(second.branch).toBe("superagent/wi_second");

    writeFileSync(join(first.worktreePath, "first.txt"), "first\n");
    writeFileSync(join(second.worktreePath, "second.txt"), "second\n");
    const firstCommit = await manager.commit(first, "功能: 第一个工作项");
    const secondCommit = await manager.commit(second, "功能: 第二个工作项");
    expect(firstCommit.sha).not.toBe(secondCommit.sha);
    expect(readFileSync(join(first.worktreePath, "first.txt"), "utf8")).toBe("first\n");
    expect(readFileSync(join(second.worktreePath, "second.txt"), "utf8")).toBe("second\n");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(originalHead);
    expect(git(repo, ["status", "--porcelain"])).toBe(originalStatus);
    expect(git(repo, ["branch", "--list", "superagent/*"])).toBe("");
  });

  it("untracked 文件进入 diff，禁止凭据文件 commit", async () => {
    const { manager } = fixture();
    const workspace = await manager.prepare("wi_forbidden", "owner/repo");
    writeFileSync(join(workspace.worktreePath, "new.txt"), "new\n");
    expect((await manager.diff(workspace)).untracked).toContain("new.txt");
    writeFileSync(join(workspace.worktreePath, ".env"), "SECRET=value\n");
    await expect(manager.commit(workspace, "功能: 不应成功")).rejects.toMatchObject({ code: "FORBIDDEN_FILE" });
  });

  it("Worker 意外 HEAD 变化被拒绝，commit 后崩溃按实际 HEAD 对账", async () => {
    const { manager } = fixture();
    const workspace = await manager.prepare("wi_reconcile", "owner/repo");
    writeFileSync(join(workspace.worktreePath, "manual.txt"), "manual\n");
    git(workspace.worktreePath, ["add", "manual.txt"]);
    git(workspace.worktreePath, [
      "-c",
      "user.name=Other",
      "-c",
      "user.email=other@example.com",
      "commit",
      "-m",
      "manual",
    ]);
    await expect(manager.commit(workspace, "功能: 重复提交")).rejects.toMatchObject({ code: "UNEXPECTED_HEAD" });
    const result = await manager.reconcile(workspace);
    expect(result.status).toBe("committed");
    expect(result.commitSha).toBe(git(workspace.worktreePath, ["rev-parse", "HEAD"]));
    await expect(manager.commit(workspace, "功能: 重复提交")).rejects.toMatchObject({ code: "UNEXPECTED_HEAD" });
  });

  it("base 未变但有未提交变更时进入 UNKNOWN，不宣称干净重跑", async () => {
    const { manager } = fixture();
    const workspace = await manager.prepare("wi_dirty", "owner/repo");
    writeFileSync(join(workspace.worktreePath, "dirty.txt"), "dirty\n");
    expect((await manager.reconcile(workspace)).status).toBe("unknown");
  });
});

describe("Worker 环境白名单", () => {
  it("模型环境可传入，GitHub/飞书写凭据绝不下发", () => {
    process.env.SPCODE_GITHUB_TOKEN = "github-secret";
    process.env.SPCODE_FEISHU_APP_SECRET = "feishu-secret";
    process.env.OPENAI_API_KEY = "model-key";
    const env = workerEnvironment({ SPCODE_WORKER_ROLE: "execute" });
    expect(env.SPCODE_GITHUB_TOKEN).toBeUndefined();
    expect(env.SPCODE_FEISHU_APP_SECRET).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBe("model-key");
    expect(env.SPCODE_WORKER_ROLE).toBe("execute");
    delete process.env.SPCODE_GITHUB_TOKEN;
    delete process.env.SPCODE_FEISHU_APP_SECRET;
    delete process.env.OPENAI_API_KEY;
  });
});
