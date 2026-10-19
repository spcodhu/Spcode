import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryDistiller } from "../src/agent-host/distill.js";
import { MemoryStore } from "../src/agent-host/memory-store.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spcode-mem-"));
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("MemoryStore", () => {
  it("首次创建播种默认文件", () => {
    new MemoryStore(dir);
    expect(existsSync(join(dir, "SOUL.md"))).toBe(true);
    expect(existsSync(join(dir, "USER.md"))).toBe(true);
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(true);
    expect(existsSync(join(dir, "memory", "lessons.md"))).toBe(true);
  });

  it("buildInjection 包含分层记忆块", () => {
    const store = new MemoryStore(dir);
    writeFileSync(join(dir, "MEMORY.md"), "# MEMORY.md\n\n## Notes\n- 用户在写 Spcode harness。\n");
    const block = store.buildInjection(null, false);
    expect(block).toContain("<soul>");
    expect(block).toContain("<long-term-memory>");
    expect(block).toContain("用户在写 Spcode harness");
  });

  it("项目会话注入项目记忆", () => {
    const store = new MemoryStore(dir);
    const cwd = "/Users/x/Code/my-proj";
    store.appendProjectMemory(cwd, "这个仓库用 pnpm 11。");
    const block = store.buildInjection(cwd, true);
    expect(block).toContain("<project-memory");
    expect(block).toContain("pnpm 11");
  });

  it("MEMORY.md 超容量被截断", () => {
    const store = new MemoryStore(dir);
    writeFileSync(join(dir, "MEMORY.md"), "x".repeat(5000));
    const block = store.buildInjection(null, false);
    expect(block.length).toBeLessThan(5000);
    expect(block).toContain("已截断");
  });

  it("projectSlug 过滤非法字符 + 路径哈希消碰撞（同名目录不再共享记忆）", () => {
    expect(MemoryStore.projectSlug("/a/b/my proj(2)")).toMatch(/^my_proj_2-[0-9a-f]{8}$/);
    expect(MemoryStore.projectSlug("/")).toMatch(/^root-[0-9a-f]{8}$/);
    // 同名不同路径 → 不同文件
    expect(MemoryStore.projectSlug("/a/app")).not.toBe(MemoryStore.projectSlug("/b/app"));
    // 同路径稳定
    expect(MemoryStore.projectSlug("/a/app")).toBe(MemoryStore.projectSlug("/a/app"));
  });

  it("writeMemoryNotes 只替换 ## Notes 段，保留用户手写的其他段落（评审 R3-C13）", () => {
    const store = new MemoryStore(dir);
    writeFileSync(
      join(dir, "MEMORY.md"),
      `# MEMORY.md - 中期记忆\n\n## Notes\n- 旧蒸馏笔记\n\n## 我的偏好\n- 用户手写：不要删我\n`,
    );
    store.writeMemoryNotes("- 新蒸馏笔记");
    const after = readFileSync(join(dir, "MEMORY.md"), "utf-8");
    expect(after).toContain("新蒸馏笔记");
    expect(after).not.toContain("旧蒸馏笔记");
    expect(after).toContain("我的偏好"); // 用户手写段落保留
    expect(after).toContain("不要删我");

    // 再写一次（无其他段落的种子文件）也不出錯
    store.writeMemoryNotes("- 第二次蒸馏");
    expect(readFileSync(join(dir, "MEMORY.md"), "utf-8")).toContain("第二次蒸馏");
  });

  it("旧格式项目记忆（纯 slug 无哈希）自动迁移到新格式", () => {
    const store = new MemoryStore(dir);
    const oldFile = join(dir, "memory", "projects", "myproj.md");
    mkdirSync(join(dir, "memory", "projects"), { recursive: true });
    writeFileSync(oldFile, "旧项目记忆内容");
    // 触发读取即迁移
    const block = store.buildInjection("/tmp/myproj", true);
    expect(block).toContain("旧项目记忆内容");
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(join(dir, "memory", "projects", `${MemoryStore.projectSlug("/tmp/myproj")}.md`))).toBe(true);
  });
});

describe("MemoryDistiller.apply", () => {
  it("解析四段 XML 并落盘", () => {
    const store = new MemoryStore(dir);
    const distiller = new MemoryDistiller(store, {
      cwd: "/tmp/proj",
      isProject: true,
      agentDir: dir,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modelRuntime: null as any,
    });
    distiller.apply(`<NOTES>
- 用户在开发 Spcode harness，基于 pi 引擎。
</NOTES>
<DIARY>
完成 M4 记忆系统，测试通过。
</DIARY>
<PROJECT>
agent-host 跑在 utilityProcess。
</PROJECT>
<LESSON>
pnpm 装 electron 前要配 onlyBuiltDependencies。
</LESSON>`);
    const memory = readFileSync(join(dir, "MEMORY.md"), "utf-8");
    expect(memory).toContain("Spcode harness");
    // R3-C13：项目记忆文件名带路径哈希（proj-<hash>.md）
    const projFile = join(dir, "memory", "projects", MemoryStore.projectSlug("/tmp/proj") + ".md");
    expect(readFileSync(projFile, "utf-8")).toContain("utilityProcess");
    expect(readFileSync(join(dir, "memory", "lessons.md"), "utf-8")).toContain("onlyBuiltDependencies");
    // 日志写到了当天文件
    const date = new Date();
    const f = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    expect(readFileSync(join(dir, "memory", `${f}.md`), "utf-8")).toContain("M4 记忆系统");
  });

  it("占位符段落不落盘", () => {
    const store = new MemoryStore(dir);
    const before = readFileSync(join(dir, "MEMORY.md"), "utf-8");
    const distiller = new MemoryDistiller(store, {
      cwd: "/tmp/x",
      isProject: false,
      agentDir: dir,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modelRuntime: null as any,
    });
    distiller.apply("<NOTES>(无变化)</NOTES><DIARY>(无)</DIARY><LESSON>(无)</LESSON>");
    expect(readFileSync(join(dir, "MEMORY.md"), "utf-8")).toBe(before);
  });
});
