/**
 * Spcode 分层记忆（借鉴 Finch 的"记忆是注意力"设计）：
 *
 *   SOUL.md                 人格（手写，注入）
 *   USER.md                 用户画像（注入）
 *   MEMORY.md               中期笔记 ## Notes（注入，容量上限强制做减法）
 *   memory/YYYY-MM-DD.md    每日日志（不注入，只追加）
 *   memory/lessons.md       教训库（注入，追加）
 *   memory/projects/<slug>.md  项目记忆（项目会话注入）
 *
 * 注入发生在会话创建时（appendSystemPrompt）；蒸馏发生在 agent_settled 后，
 * 由 distill.ts 驱动模型把值得长期保留的事实写回 MEMORY.md 与当日日志。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { baseName } from "@spcode/shared";
import { writeFileAtomic } from "@spcode/shared/node";

const MEMORY_MD_MAX_CHARS = 3200; // ≈800 tokens 的中文上限
const SOUL_MD_MAX_CHARS = 2000;
const USER_MD_MAX_CHARS = 1600;
const PROJECT_MD_MAX_CHARS = 2400;

export class MemoryStore {
  readonly home: string;
  readonly memoryDir: string;

  constructor(home: string) {
    this.home = home;
    this.memoryDir = join(home, "memory");
    mkdirSync(this.memoryDir, { recursive: true });
    mkdirSync(join(this.memoryDir, "projects"), { recursive: true });
    this.seedDefaults();
  }

  private seedDefaults(): void {
    this.seedIfMissing(
      "SOUL.md",
      `# SOUL.md - Spcod 的人格

你是 Spcod，一个以 Pi 为引擎的 Agentic Code 工作台里的助手。

- 直接做事，不说废话。"好的，我来帮你"这类开场白全省略。
- 有自己的判断：可以不同意、可以偏好某种做法，并说明理由。
- 先尝试自己解决（读文件、查上下文、搜索），确实卡住了再问。
- 用户的机器是客人的地盘：对外动作（发消息、推送、发布）先问，对内动作（读、改、学）放手做。
`,
    );
    this.seedIfMissing(
      "USER.md",
      `# USER.md - 关于用户

- **Name:** （待用户补充）
- **Timezone:** UTC+8

（蒸馏会随了解加深自动补充稳定偏好。）
`,
    );
    this.seedIfMissing(
      "MEMORY.md",
      `# MEMORY.md - 中期记忆

## Notes
（暂无。会话结束时蒸馏会自动把值得记住的项目动态写到这里。）
`,
    );
    this.seedIfMissing(
      join("memory", "lessons.md"),
      `# lessons.md - 教训库

（从失败与纠正中学到的工具/命令规则。格式：- [信任分 0-100] 规则）
`,
    );
  }

  private seedIfMissing(relPath: string, content: string): void {
    const file = join(this.home, relPath);
    if (!existsSync(file)) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, content, "utf-8");
    }
  }

  private readCapped(relPath: string, maxChars: number): string {
    const file = isAbsolute(relPath) ? relPath : join(this.home, relPath);
    if (!existsSync(file)) return "";
    let text = readFileSync(file, "utf-8").trim();
    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars)}\n…（超出容量已截断）`;
    }
    return text;
  }

  /** 项目记忆文件路径：新格式 <slug>-<hash>.md 优先；旧格式（纯 slug，R3-C13 前）存在则迁移改名 */
  private projectFile(cwd: string): string {
    const dir = join(this.memoryDir, "projects");
    const next = join(dir, `${MemoryStore.projectSlug(cwd)}.md`);
    if (existsSync(next)) return next;
    // 旧格式查找（纯 slug 无哈希）
    const base = baseName(cwd.replace(/[\\/]+$/, "")) || "root";
    const old = join(
      dir,
      `${
        base
          .replace(/[^\p{L}\p{N}._-]+/gu, "_")
          .replace(/^_+|_+$/g, "")
          .slice(0, 60) || "root"
      }.md`,
    );
    if (existsSync(old)) {
      try {
        writeFileAtomic(next, readFileSync(old, "utf-8"));
        rmSync(old);
      } catch {
        return old; // 迁移失败先用旧的（下次再试）
      }
    }
    return next;
  }
  /** 项目目录 → 项目记忆文件名（basename + 路径短哈希：两个同名目录不再共享一份记忆——评审 R3-C13） */
  static projectSlug(cwd: string): string {
    const base = baseName(cwd.replace(/[\\/]+$/, "")) || "root";
    const slug = base
      .replace(/[^\p{L}\p{N}._-]+/gu, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60);
    // 短哈希：djb2 变体（非加密用途，只消碰撞），hex 8 位足够区分同名项目
    let h = 5381;
    for (let i = 0; i < cwd.length; i++) h = ((h << 5) + h + cwd.charCodeAt(i)) >>> 0;
    return `${slug || "root"}-${h.toString(16).padStart(8, "0")}`;
  }

  /** 组装注入系统提示的记忆块 */
  buildInjection(cwd: string | null, isProject: boolean): string {
    const parts: string[] = [];
    const soul = this.readCapped("SOUL.md", SOUL_MD_MAX_CHARS);
    if (soul) parts.push(`<soul>\n${soul}\n</soul>`);
    const user = this.readCapped("USER.md", USER_MD_MAX_CHARS);
    if (user) parts.push(`<user-profile>\n${user}\n</user-profile>`);
    const memory = this.readCapped("MEMORY.md", MEMORY_MD_MAX_CHARS);
    if (memory) parts.push(`<long-term-memory>\n${memory}\n</long-term-memory>`);
    if (isProject && cwd) {
      const proj = this.readCapped(this.projectFile(cwd), PROJECT_MD_MAX_CHARS);
      if (proj) parts.push(`<project-memory project="${cwd}">\n${proj}\n</project-memory>`);
    }
    const lessons = this.readCapped(join("memory", "lessons.md"), 1200);
    if (lessons && !lessons.startsWith("# lessons.md - 教训库\n\n（")) {
      parts.push(`<lessons>\n${lessons}\n</lessons>`);
    }
    if (parts.length === 0) return "";
    return [
      "# Spcod Memory",
      "",
      "以下是 Spcod 的分层记忆。它们是你与用户、项目长期相处沉淀下来的事实，",
      "优先级高于你的通用假设；与会话中的新信息冲突时，以新信息为准并在蒸馏时修正记忆。",
      "",
      parts.join("\n\n"),
    ].join("\n");
  }

  // -------------------------------------------------------------------------
  // 写入（蒸馏用）
  // -------------------------------------------------------------------------

  appendDailyLog(text: string, now = new Date()): void {
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const file = join(this.memoryDir, `${date}.md`);
    appendFileSync(file, `\n## ${time}\n\n${text.trim()}\n`, "utf-8");
  }

  /**
   * 用蒸馏产物替换 MEMORY.md 的 ## Notes 段（评审 R3-C13）：
   * - 只替换 ## Notes 段，保留用户手写的其他段落（原实现整文件重建，自定义段落会被静默抹掉）
   * - 原子写（崩溃不再截断丢全部记忆）
   * - 容量超限按行截断，不截在行中间
   */
  writeMemoryNotes(notesMarkdown: string): void {
    const file = join(this.home, "MEMORY.md");
    const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
    const notes = notesMarkdown.trim();

    let body: string;
    if (!existing.trim()) {
      body = `# MEMORY.md - 中期记忆\n\n## Notes\n${notes}\n`;
    } else {
      // 有 ## Notes 段则原位替换，没有则在文件头（首个 ## 之前或标题行后）插入
      const sectionRe = /(^|\n)## Notes\n[\s\S]*?(?=\n## |$)/;
      if (sectionRe.test(existing)) {
        body = existing.replace(sectionRe, (m) => `${m.startsWith("\n") ? "\n" : ""}## Notes\n${notes}\n`);
      } else {
        const lines = existing.split("\n");
        const titleEnd = lines[0]?.startsWith("#") ? 1 : 0;
        lines.splice(titleEnd, 0, "", `## Notes\n${notes}`);
        body = lines.join("\n");
      }
    }
    if (body.length > MEMORY_MD_MAX_CHARS) {
      const cut = body.slice(0, MEMORY_MD_MAX_CHARS);
      const lastNl = cut.lastIndexOf("\n");
      body = `${lastNl > 0 ? cut.slice(0, lastNl) : cut}\n`;
    }
    writeFileAtomic(file, body);
  }

  appendProjectMemory(cwd: string, text: string): void {
    appendFileSync(this.projectFile(cwd), `\n${text.trim()}\n`, "utf-8");
  }

  appendLesson(text: string): void {
    appendFileSync(join(this.memoryDir, "lessons.md"), `\n- [60] ${text.trim()}\n`, "utf-8");
  }

  /** 设置界面展示用：读取全部记忆文件内容 */
  readAll(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of ["SOUL.md", "USER.md", "MEMORY.md"]) {
      out[name] = this.readCapped(name, 10000);
    }
    out["lessons.md"] = this.readCapped(join("memory", "lessons.md"), 10000);
    const projectsDir = join(this.memoryDir, "projects");
    if (existsSync(projectsDir)) {
      for (const f of readdirSync(projectsDir).filter((x) => x.endsWith(".md"))) {
        out[`projects/${f}`] = this.readCapped(join("memory", "projects", f), 6000);
      }
    }
    return out;
  }
}
