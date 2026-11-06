import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGuardedFsTools, type FsGuardPolicy } from "../src/agent-host/sandbox/fs-guard.js";

let root = "";
let cwd = "";
let policy: FsGuardPolicy;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "spcode-file-contract-"));
  cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  policy = { cwd, spcodeHome: join(root, "home"), extraDenyRead: [], extraAllowWrite: [] };
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

interface ToolSet {
  read: ToolDefinition;
  write: ToolDefinition;
  edit: ToolDefinition;
}

function makeTools(): ToolSet {
  const tools = createGuardedFsTools(cwd, () => policy);
  return {
    read: tools.find((tool) => tool.name === "read")!,
    write: tools.find((tool) => tool.name === "write")!,
    edit: tools.find((tool) => tool.name === "edit")!,
  };
}

function execute(tool: ToolDefinition, args: Record<string, unknown>) {
  return tool.execute("test-call", args as never, undefined, undefined, { cwd } as never);
}

function seed(name: string, content: string): string {
  const file = join(cwd, name);
  writeFileSync(file, content, "utf-8");
  return file;
}

describe("文件工具 read-before-modify 与版本契约", () => {
  it("新文件可直接 Write 并自动创建父目录", async () => {
    const tools = makeTools();
    await execute(tools.write, { path: "nested/new.txt", content: "new" });
    expect(readFileSync(join(cwd, "nested/new.txt"), "utf-8")).toBe("new");
  });

  it("已有文件未 Read 时 Write/Edit 均拒绝且不改内容", async () => {
    const tools = makeTools();
    const file = seed("existing.txt", "original");
    await expect(execute(tools.write, { path: file, content: "overwrite" })).rejects.toMatchObject({
      code: "FILE_NOT_READ",
    });
    await expect(
      execute(tools.edit, { path: file, edits: [{ oldText: "original", newText: "changed" }] }),
    ).rejects.toMatchObject({ code: "FILE_NOT_READ" });
    expect(readFileSync(file, "utf-8")).toBe("original");
  });

  it("失败 Read 不解锁；成功 Read 后可写，Write/Edit 会刷新自身已知版本", async () => {
    const tools = makeTools();
    const file = seed("flow.txt", "v1");

    await expect(execute(tools.read, { path: file, offset: 99 })).rejects.toThrow("beyond end of file");
    await expect(execute(tools.write, { path: file, content: "not-allowed" })).rejects.toMatchObject({
      code: "FILE_NOT_READ",
    });

    await execute(tools.read, { path: file });
    await execute(tools.write, { path: file, content: "v2" });
    await execute(tools.edit, { path: file, edits: [{ oldText: "v2", newText: "v3" }] });
    await execute(tools.write, { path: file, content: "v4" });
    expect(readFileSync(file, "utf-8")).toBe("v4");
  });

  it("Read 后外部变化使 Write/Edit 过期，重新 Read 后恢复", async () => {
    const tools = makeTools();
    const file = seed("stale.txt", "v1");
    await execute(tools.read, { path: file });
    writeFileSync(file, "external-v2", "utf-8");

    await expect(execute(tools.write, { path: file, content: "overwrite" })).rejects.toMatchObject({
      code: "FILE_STALE",
    });
    await expect(
      execute(tools.edit, { path: file, edits: [{ oldText: "external-v2", newText: "edit-v3" }] }),
    ).rejects.toMatchObject({ code: "FILE_STALE" });
    expect(readFileSync(file, "utf-8")).toBe("external-v2");

    await execute(tools.read, { path: file });
    await execute(tools.edit, { path: file, edits: [{ oldText: "external-v2", newText: "edit-v3" }] });
    expect(readFileSync(file, "utf-8")).toBe("edit-v3");

    writeFileSync(file, "external-v4", "utf-8");
    await expect(
      execute(tools.edit, { path: file, edits: [{ oldText: "external-v4", newText: "not-allowed" }] }),
    ).rejects.toMatchObject({ code: "FILE_STALE" });
  });

  it("相对/@/绝对路径共享版本；不同工具组的账本相互隔离", async () => {
    const first = makeTools();
    const file = seed("alias.txt", "v1");
    await execute(first.read, { path: "@alias.txt" });
    await execute(first.write, { path: file, content: "v2" });
    expect(readFileSync(file, "utf-8")).toBe("v2");

    const second = makeTools();
    await expect(execute(second.edit, { path: file, edits: [{ oldText: "v2", newText: "v3" }] })).rejects.toMatchObject(
      { code: "FILE_NOT_READ" },
    );
  });

  it.runIf(process.platform !== "win32")("符号链接与真实路径共享版本", async () => {
    const tools = makeTools();
    const file = seed("target.txt", "v1");
    const link = join(cwd, "link.txt");
    symlinkSync(file, link);
    await execute(tools.read, { path: "link.txt" });
    await execute(tools.write, { path: file, content: "v2" });
    expect(readFileSync(link, "utf-8")).toBe("v2");
  });
});
