/**
 * session-git 单测（评审 R3-F2）：真实 git 仓库（临时目录）验证基线/改动判定/还原链路。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitBaseline, gitDiff, gitStashPush, gitStatusPorcelain, hasChanges } from "../src/main/session-git.js";

let dir = "";
let repo = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "spcode-git-"));
  repo = join(dir, "repo");
  execFileSync("git", ["init", repo], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "pipe" });
  writeFileSync(join(repo, "a.txt"), "hello\n");
  execFileSync("git", ["-C", repo, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "commit", "-m", "init"], { stdio: "pipe" });
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("session-git", () => {
  it("非 git 目录：baseline 返回 null", async () => {
    expect(await gitBaseline(join(dir, "not-a-repo"))).toBeNull();
  });

  it("基线 → 改动判定 → diff 内容 → stash 还原后工作区干净", async () => {
    const base = await gitBaseline(repo);
    expect(base).not.toBeNull();
    expect(base!.head).toMatch(/^[0-9a-f]{40}$/);

    // 干净时无变化
    const clean = await gitStatusPorcelain(repo);
    expect(hasChanges(base!, clean!)).toBe(false);

    // 制造改动：改已跟踪文件 + 新增未跟踪文件
    writeFileSync(join(repo, "a.txt"), "hello\nworld\n");
    writeFileSync(join(repo, "new.ts"), "export {};\n");
    const dirty = await gitStatusPorcelain(repo);
    expect(hasChanges(base!, dirty!)).toBe(true);

    const diff = await gitDiff(repo);
    expect(diff).not.toBeNull();
    expect(diff!.stat).toContain("a.txt");
    expect(diff!.patch).toContain("+world");
    expect(diff!.untracked).toContain("new.ts");

    // 还原 = stash push（含未跟踪）；还原后工作区与基线一致
    const out = await gitStashPush(repo, "spcode rewind: test");
    expect(out).toBeTruthy();
    const after = await gitStatusPorcelain(repo);
    expect(hasChanges(base!, after!)).toBe(false);

    // stash 可找回（可恢复性验证）
    const stashList = execFileSync("git", ["-C", repo, "stash", "list"], { encoding: "utf-8" });
    expect(stashList).toContain("spcode rewind");
  });
});
