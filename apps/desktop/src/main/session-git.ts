/**
 * 会话改动可见性（评审 R3-F2 的 MVP 半区）：
 * 项目会话（cwd 是 git 仓库）在首次 prompt 前记录 git 基线（HEAD + 状态指纹），
 * 运行后可随时「查看改动」（git diff HEAD）与「还原」（git stash push——可恢复的撤销，
 * 不用 checkout -- . 这种不可逆破坏）。
 *
 * 全部走 execFile（主进程直接跑 git——这是 harness 自身的 UI 动作，不是模型工具调用，
 * 不进权限网关/沙盒；语义对齐 Cline/Claude Code 的 checkpoint 查看面）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const MAX_PATCH_BYTES = 3 * 1024 * 1024;

export interface GitBaseline {
  head: string;
  /** git status --porcelain 的原文（含未跟踪文件），用于判断相对基线是否有变化 */
  statusPorcelain: string;
  at: number;
}

export interface GitDiffResult {
  /** git diff --stat 输出（人类可读摘要） */
  stat: string;
  /** git diff HEAD 全文（截断到 3MB） */
  patch: string;
  /** 未跟踪文件列表（不在 diff 里，单独列出） */
  untracked: string[];
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_PATCH_BYTES,
  });
  return stdout;
}

/** cwd 是否 git 仓库（且能取到 HEAD；空仓无提交不算） */
export async function gitBaseline(cwd: string): Promise<GitBaseline | null> {
  try {
    const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    const statusPorcelain = await git(cwd, ["status", "--porcelain"]);
    return { head, statusPorcelain, at: Date.now() };
  } catch {
    return null;
  }
}

/** 相对基线的工作区改动：stat 摘要 + 完整 patch + 未跟踪文件 */
export async function gitDiff(cwd: string): Promise<GitDiffResult | null> {
  try {
    const stat = (await git(cwd, ["diff", "--stat", "HEAD"])).trim();
    const patch = await git(cwd, ["diff", "HEAD"]);
    const untrackedRaw = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
    const untracked = untrackedRaw.split("\n").filter(Boolean);
    return { stat, patch, untracked };
  } catch {
    return null;
  }
}

/** 基线是否已过时（工作区与基线不同即视为有改动——不逐行对比 diff，用 status 指纹粗判） */
export function hasChanges(base: GitBaseline, currentPorcelain: string): boolean {
  return base.statusPorcelain !== currentPorcelain;
}

/** 还原 = git stash push（含未跟踪），改动进 stash 可 git stash pop 找回。返回 stash 提示文本 */
export async function gitStashPush(cwd: string, message: string): Promise<string | null> {
  try {
    return (await git(cwd, ["stash", "push", "-u", "-m", message])).trim();
  } catch {
    return null;
  }
}

/** 当前 status 指纹（基线对比用） */
export async function gitStatusPorcelain(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, ["status", "--porcelain"]);
  } catch {
    return null;
  }
}
