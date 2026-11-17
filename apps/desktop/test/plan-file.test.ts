import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isExistingPlanFile, readSessionPlan, resolveSessionPlanPath } from "../src/main/plan-file.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "spcode-plan-file-"));
  mkdirSync(join(home, "plans"), { recursive: true });
  writeFileSync(join(home, "plans", "s1.md"), "# 计划正文\n", "utf-8");
  writeFileSync(join(home, "secret.md"), "secret", "utf-8");
  writeFileSync(join(home, "outside.md"), "outside", "utf-8");
});
afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("Plan 文件读取边界", () => {
  it("读取 plans 目录直接子级 Markdown", () => {
    expect(readSessionPlan(join(home, "plans", "s1.md"), home)).toBe("# 计划正文\n");
  });

  it("拒绝目录穿越、上级文件和非 Markdown", () => {
    expect(() => readSessionPlan(join(home, "plans", "..", "secret.md"), home)).toThrow("Invalid plan file path");
    expect(() => readSessionPlan(join(home, "secret.md"), home)).toThrow("Invalid plan file path");
    expect(() => readSessionPlan(join(home, "plans", "s1.txt"), home)).toThrow("Invalid plan file path");
  });

  it.runIf(process.platform !== "win32")("符号链接指向 plans 之外时拒绝（评审 R5 P2-2）", () => {
    const link = join(home, "plans", "escape.md");
    symlinkSync(join(home, "outside.md"), link);
    expect(() => resolveSessionPlanPath(link, home)).toThrow("Invalid plan file path");
  });

  it("未落盘的计划文件保留原路径，存在性判定为 false", () => {
    const missing = join(home, "plans", "not-written.md");
    expect(resolveSessionPlanPath(missing, home)).toBe(missing);
    expect(isExistingPlanFile(missing)).toBe(false);
    expect(isExistingPlanFile(join(home, "plans", "s1.md"))).toBe(true);
    // 目录不是计划文件
    expect(isExistingPlanFile(join(home, "plans"))).toBe(false);
  });
});
