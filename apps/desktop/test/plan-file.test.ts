import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSessionPlan } from "../src/main/plan-file.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "spcode-plan-file-"));
  mkdirSync(join(home, "plans"), { recursive: true });
  writeFileSync(join(home, "plans", "s1.md"), "# 计划正文\n", "utf-8");
  writeFileSync(join(home, "secret.md"), "secret", "utf-8");
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
});
