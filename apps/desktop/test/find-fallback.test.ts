import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFindToolWithFallback } from "../src/agent-host/tools/find-fallback.js";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "spcode-find-fallback-"));
  for (const dir of ["src/nested", "build", "node_modules/pkg"]) mkdirSync(join(root, dir), { recursive: true });
  for (const file of [
    "root.txt",
    "README.md",
    "src/a.ts",
    "src/nested/b.ts",
    "src/nested/c.md",
    "ignored.log",
    "build/out.ts",
    "node_modules/pkg/ignored.ts",
    "src/.hidden.xml",
  ]) {
    writeFileSync(join(root, file), file, "utf-8");
  }
  writeFileSync(join(root, ".gitignore"), "ignored.log\nbuild/\n", "utf-8");
  writeFileSync(join(root, "src", ".gitignore"), "c.md\n", "utf-8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function find(pattern: string, limit = 100): Promise<string> {
  const tool = createFindToolWithFallback(root, "/nonexistent/fd/path");
  const result = await tool.execute("t1", { pattern, path: root, limit }, undefined, undefined as never, undefined as never);
  expect(result.isError).toBeFalsy();
  return result.content?.[0]?.text ?? "";
}

describe("createFindToolWithFallback（fd 不可用）", () => {
  it("basename 匹配递归文件并遵守根 .gitignore", async () => {
    const output = await find("*.ts");
    expect(output).toContain("src/a.ts");
    expect(output).toContain("src/nested/b.ts");
    expect(output).not.toContain("build");
    expect(output).not.toContain("ignored.log");
    expect(output).not.toContain("node_modules");
  });

  it("full-path 匹配保留 src 前缀并遵守嵌套 .gitignore", async () => {
    const ts = await find("src/**/*.ts");
    expect(ts).toContain("src/a.ts");
    expect(ts).toContain("src/nested/b.ts");

    const md = await find("*.md");
    expect(md).toContain("README.md");
    expect(md).not.toContain("src/nested/c.md");
  });

  it("隐藏目录与绝对路径模式保持可用", async () => {
    const hidden = await find("*.xml");
    expect(hidden).toContain("src/.hidden.xml");

    const absolute = await find(join(root, "src", "*.ts"));
    expect(absolute).toContain("src/a.ts");
    expect(absolute).not.toContain("src/nested/b.ts");
  });
});
