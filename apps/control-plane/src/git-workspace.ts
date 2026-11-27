import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface GitWorkspace {
  workItemId: string;
  repo: string;
  sourcePath: string;
  mirrorPath: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitDiffSnapshot {
  stat: string;
  patch: string;
  files: string[];
  untracked: string[];
}

export class GitWorkspaceError extends Error {
  constructor(
    message: string,
    readonly code: "GIT_FAILED" | "DIRTY_COMMIT" | "UNEXPECTED_HEAD" | "FORBIDDEN_FILE" | "RECONCILIATION_REQUIRED",
  ) {
    super(message);
    this.name = "GitWorkspaceError";
  }
}

const FORBIDDEN = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)\.finch\//i,
  /(^|\/)test-results\//i,
  /(^|\/)(?:out|dist|release)\//i,
  /(^|\/)(?:auth\.json|device-token|runtime\.json)$/i,
  /(^|\/)control\.sqlite(?:-|$)/i,
  /(^|\/)[^/]+\.(?:pem|p12|pfx|key)$/i,
];

function cleanEnv(): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "TERM",
  ]);
  const env: NodeJS.ProcessEnv = { CI: "1", GIT_TERMINAL_PROMPT: "0" };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (allowed.has(key) || /^(?:npm_config_cache|XDG_CACHE_HOME)$/.test(key)))
      env[key] = value;
  }
  return env;
}

export function runGit(args: string[], cwd?: string, timeoutMs = 60_000): Promise<GitCommandResult> {
  return new Promise((resolveResult, reject) => {
    execFile(
      "git",
      args,
      { cwd, env: cleanEnv(), timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new GitWorkspaceError("系统找不到 git", "GIT_FAILED"));
          return;
        }
        const code =
          typeof (error as { code?: unknown } | null)?.code === "number"
            ? (error as unknown as { code: number }).code
            : error
              ? 1
              : 0;
        if (error && (error as { killed?: boolean }).killed) {
          reject(new GitWorkspaceError(`git 命令超时：git ${args.join(" ")}`, "GIT_FAILED"));
          return;
        }
        resolveResult({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
  });
}

async function git(args: string[], cwd?: string, timeoutMs?: number): Promise<string> {
  const result = await runGit(args, cwd, timeoutMs);
  if (result.code !== 0) {
    throw new GitWorkspaceError(
      `git ${args.join(" ")} 失败：${result.stderr.trim() || result.stdout.trim()}`,
      "GIT_FAILED",
    );
  }
  return result.stdout.trim();
}

function parseStatus(raw: string): Array<{ path: string; untracked: boolean }> {
  if (!raw) return [];
  return raw
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const path = entry.length > 3 && (entry[2] === " " || entry[1] === " ") ? entry.slice(3) : entry.slice(3);
      return { path, untracked: entry.startsWith("??") };
    });
}

export class GitWorkspaceManager {
  private readonly mirrorLocks = new Map<string, Promise<void>>();

  constructor(
    readonly baseDir: string,
    private readonly resolveSource: (repo: string) => string,
  ) {
    mkdirSync(join(baseDir, "mirrors"), { recursive: true });
    mkdirSync(join(baseDir, "worktrees"), { recursive: true });
  }

  async prepare(workItemId: string, repo: string, approvedBaseSha?: string): Promise<GitWorkspace> {
    const configured = this.resolveSource(repo).trim();
    if (!configured) throw new GitWorkspaceError(`仓库 ${repo} 未配置本地路径`, "GIT_FAILED");
    let source = configured;
    if (!/^[a-z]+:\/\//i.test(configured)) {
      source = await realpath(resolve(configured));
      const top = await git(["rev-parse", "--show-toplevel"], source);
      if (resolve(top) !== resolve(source)) source = top;
    } else {
      const url = new URL(configured);
      if (url.username || url.password) throw new GitWorkspaceError("仓库 URL 不得携带凭据", "GIT_FAILED");
    }
    const key = createHash("sha256").update(repo).digest("hex").slice(0, 24);
    const mirrorPath = join(this.baseDir, "mirrors", `${key}.git`);
    return this.withMirrorLock(mirrorPath, async () => {
      if (!existsSync(mirrorPath)) {
        await git(["clone", "--mirror", "--no-hardlinks", source, mirrorPath], undefined, 180_000);
      } else {
        await git(
          ["--git-dir", mirrorPath, "fetch", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"],
          undefined,
          180_000,
        );
      }
      const baseSha = approvedBaseSha
        ? await (async () => {
            await git(["--git-dir", mirrorPath, "cat-file", "-e", `${approvedBaseSha}^{commit}`]);
            return approvedBaseSha;
          })()
        : !/^[a-z]+:\/\//i.test(source)
          ? await git(["rev-parse", "HEAD"], source)
          : await git(["--git-dir", mirrorPath, "rev-parse", "HEAD"]);
      const worktreePath = join(this.baseDir, "worktrees", workItemId);
      const branch = `superagent/${workItemId}`;
      if (existsSync(worktreePath)) {
        const currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
        if (currentBranch !== branch) throw new GitWorkspaceError("已有 worktree 分支不匹配", "UNEXPECTED_HEAD");
      } else {
        await git(
          ["--git-dir", mirrorPath, "worktree", "add", "-b", branch, worktreePath, baseSha],
          undefined,
          120_000,
        );
      }
      return { workItemId, repo, sourcePath: source, mirrorPath, worktreePath, branch, baseSha };
    });
  }

  private async withMirrorLock<T>(mirrorPath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mirrorLocks.get(mirrorPath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    this.mirrorLocks.set(mirrorPath, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.mirrorLocks.get(mirrorPath) === current) this.mirrorLocks.delete(mirrorPath);
    }
  }

  async inspect(worktreePath: string, branch: string, baseSha: string): Promise<GitWorkspace> {
    const repo = await git(["rev-parse", "--show-toplevel"], worktreePath);
    return {
      workItemId: "",
      repo,
      sourcePath: "",
      mirrorPath: resolve(worktreePath, await git(["rev-parse", "--git-common-dir"], worktreePath)),
      worktreePath,
      branch,
      baseSha,
    };
  }

  async assertExpectedHead(workspace: GitWorkspace): Promise<void> {
    const [head, branch, root] = await Promise.all([
      git(["rev-parse", "HEAD"], workspace.worktreePath),
      git(["rev-parse", "--abbrev-ref", "HEAD"], workspace.worktreePath),
      git(["rev-parse", "--show-toplevel"], workspace.worktreePath),
    ]);
    const [actualRoot, expectedRoot] = await Promise.all([realpath(root), realpath(workspace.worktreePath)]);
    if (actualRoot !== expectedRoot) {
      throw new GitWorkspaceError("worktree realpath 发生变化", "UNEXPECTED_HEAD");
    }
    if (branch !== workspace.branch || head !== workspace.baseSha) {
      throw new GitWorkspaceError(`Worker 意外改变 HEAD 或分支：${branch} ${head}`, "UNEXPECTED_HEAD");
    }
  }

  async diff(workspace: GitWorkspace): Promise<GitDiffSnapshot> {
    const [status, stat, patch] = await Promise.all([
      git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], workspace.worktreePath),
      git(["diff", "--stat", workspace.baseSha], workspace.worktreePath),
      git(["diff", "--no-ext-diff", "--unified=3", workspace.baseSha], workspace.worktreePath),
    ]);
    const entries = parseStatus(status);
    const untracked = entries.filter((entry) => entry.untracked).map((entry) => entry.path);
    const additions: string[] = [];
    for (const file of untracked) {
      const result = await runGit(["diff", "--no-index", "--", "/dev/null", file], workspace.worktreePath);
      if (result.code > 1) throw new GitWorkspaceError(`读取 untracked diff 失败：${result.stderr}`, "GIT_FAILED");
      additions.push(result.stdout);
    }
    const patchWithUntracked = [patch, ...additions].filter(Boolean).join("\n");
    const statWithUntracked = [
      stat,
      ...additions.map((diff) => `${diff.split("\n").filter((line) => line.startsWith("+")).length} additions`),
    ]
      .filter(Boolean)
      .join("\n");
    return {
      stat: statWithUntracked,
      patch: patchWithUntracked,
      files: entries.filter((entry) => !entry.untracked).map((entry) => entry.path),
      untracked,
    };
  }

  async commit(workspace: GitWorkspace, message: string): Promise<{ sha: string; diff: GitDiffSnapshot }> {
    await this.assertExpectedHead(workspace);
    const diff = await this.diff(workspace);
    const files = [...diff.files, ...diff.untracked];
    if (files.length === 0) throw new GitWorkspaceError("没有可提交的变更", "DIRTY_COMMIT");
    const forbidden = files.find((file) => FORBIDDEN.some((pattern) => pattern.test(file)));
    if (forbidden) throw new GitWorkspaceError(`禁止提交的文件：${forbidden}`, "FORBIDDEN_FILE");
    const cleanMessage = message.trim().slice(0, 500);
    if (!cleanMessage) throw new GitWorkspaceError("commit message 为空", "DIRTY_COMMIT");
    await git(["add", "--all", "--", "."], workspace.worktreePath);
    const stagedForbidden = (await git(["diff", "--cached", "--name-only"], workspace.worktreePath))
      .split("\n")
      .filter(Boolean)
      .find((file) => FORBIDDEN.some((pattern) => pattern.test(file)));
    if (stagedForbidden) throw new GitWorkspaceError(`暂存区含禁止文件：${stagedForbidden}`, "FORBIDDEN_FILE");
    await git(
      [
        "-c",
        "user.name=Spcode Super Agent",
        "-c",
        "user.email=superagent@localhost",
        "commit",
        "--no-gpg-sign",
        "-m",
        cleanMessage,
      ],
      workspace.worktreePath,
      120_000,
    );
    return { sha: await git(["rev-parse", "HEAD"], workspace.worktreePath), diff };
  }

  /** commit 后/回执前崩溃：只观察实际 HEAD 与工作区，不盲目再次 commit。 */
  async reconcile(
    workspace: GitWorkspace,
  ): Promise<{ status: "clean-base" | "committed" | "unknown"; commitSha?: string; detail: string }> {
    const head = await git(["rev-parse", "HEAD"], workspace.worktreePath);
    const status = await git(["status", "--porcelain=v1", "--untracked-files=all"], workspace.worktreePath);
    if (head === workspace.baseSha) {
      return status
        ? { status: "unknown", detail: "baseSha 未变但 worktree 仍有未提交变更" }
        : { status: "clean-base", detail: "进程已退出且 worktree 干净，可安全重试" };
    }
    const count = await git(["rev-list", "--count", `${workspace.baseSha}..HEAD`], workspace.worktreePath);
    const ancestor = await runGit(["merge-base", "--is-ancestor", workspace.baseSha, "HEAD"], workspace.worktreePath);
    if (!status && ancestor.code === 0 && count === "1") {
      return { status: "committed", commitSha: head, detail: "发现基线之上的唯一本地 commit 且工作区干净" };
    }
    return {
      status: "unknown",
      detail: `HEAD=${head}，base 之后 commit 数=${count}，工作区${status ? "有" : "无"}变更`,
    };
  }

  async cleanup(workspace: GitWorkspace): Promise<void> {
    if (existsSync(workspace.worktreePath)) {
      await git(["--git-dir", workspace.mirrorPath, "worktree", "remove", workspace.worktreePath]);
    }
    await runGit(["--git-dir", workspace.mirrorPath, "branch", "-D", workspace.branch]);
    await git(["--git-dir", workspace.mirrorPath, "worktree", "prune"]);
  }
}

export function workerEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = cleanEnv();
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      (["SPCODE_HOME", "SPCODE_I18N_PROFILE"].includes(key) ||
        /^(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE|DEEPSEEK|MOONSHOT|QWEN|DASHSCOPE|ZAI|AWS|AZURE)_/.test(key))
    ) {
      env[key] = value;
    }
  }
  // 飞书/GitHub 写凭据、relay secret 和任意其他应用密钥明确不下发 Worker。
  return { ...env, ...extra };
}
