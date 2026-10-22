import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { setLocale } from "@spcode/shared/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHandoffPrompt, exportSessionContext, renderTranscript } from "../src/agent-host/export-context.js";
import { teardownHostEvents, useStore } from "../src/renderer/src/store.js";

/**
 * 会话上下文导出（handoff）：transcript 渲染、接力提示词模板、三件套落盘。
 * fixture 用 pi 的真实 SessionManager 在临时目录落会话文件（不 mock 引擎结构）。
 */

const tmpDirs: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "spcode-export-test-"));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => setLocale("zh-CN"));
afterEach(() => {
  setLocale("zh-CN");
  teardownHostEvents();
  vi.unstubAllGlobals();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** 造一个真实会话文件：user → assistant(thinking+text+toolCall) → toolResult → 图片消息 */
function makeSessionFile(dir: string): string {
  const sm = SessionManager.create("/tmp/proj", dir);
  sm.appendMessage({ role: "user", content: "帮我看下登录模块的结构", timestamp: Date.now() });
  sm.appendMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "先看目录结构" },
      { type: "text", text: "好的，我先看一下项目结构。" },
      { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls src" } },
    ],
    timestamp: Date.now(),
  } as never);
  sm.appendMessage({
    role: "toolResult",
    toolCallId: "tc1",
    toolName: "bash",
    content: [{ type: "text", text: "a.ts\nb.ts" }],
    isError: false,
    timestamp: Date.now(),
  } as never);
  sm.appendMessage({
    role: "user",
    content: [
      { type: "text", text: "这个截图里的报错看下" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  } as never);
  const file = sm.getSessionFile();
  if (!file) throw new Error("fixture 会话文件未落盘");
  return file;
}

describe("renderTranscript", () => {
  it("localizes only generated export headings, keeping conversation and thinking unchanged", () => {
    const dir = makeTmp();
    const file = makeSessionFile(dir);
    const sm = SessionManager.open(file);
    const before = readFileSync(file, "utf-8");
    setLocale("en");
    const { markdown } = renderTranscript(sm.getBranch(), {
      title: "原始标题 <raw>",
      cwd: "/tmp/项目",
      exportedAt: new Date("2026-01-01T12:00:00Z"),
    });
    expect(markdown).toContain("# Session transcript: 原始标题 <raw>");
    expect(markdown).toContain("Working directory: /tmp/项目");
    expect(markdown).toContain("**Thinking**");
    expect(markdown).toContain("Tool call: `bash`");
    expect(markdown).toContain("Image: image/png");
    expect(markdown).toContain("帮我看下登录模块的结构");
    expect(markdown).toContain("先看目录结构");
    expect(markdown).toContain("好的，我先看一下项目结构。");
    expect(markdown).toContain("a.ts\nb.ts");
    expect(readFileSync(file, "utf-8")).toBe(before);
    const handoff = buildHandoffPrompt({
      transcriptPath: "/tmp/记录.md",
      jsonlPath: file,
      cwd: "/tmp/项目",
      title: "原始标题",
      messages: 3,
      exportedAt: new Date(),
      memoryPaths: [],
    });
    expect(handoff).toContain("English (en)");
    expect(handoff).toContain("/tmp/记录.md");
    expect(handoff).toContain("原始标题");
  });

  it("渲染 user/assistant/thinking/工具调用与结果，图片占位不内联 base64", () => {
    const dir = makeTmp();
    const file = makeSessionFile(dir);
    const sm = SessionManager.open(file);
    const { markdown, messages } = renderTranscript(sm.getBranch(), {
      title: "登录模块排查",
      cwd: "/tmp/proj",
      exportedAt: new Date("2026-01-01T12:00:00"),
    });
    expect(messages).toBe(3);
    expect(markdown).toContain("# 会话记录：登录模块排查");
    expect(markdown).toContain("## 🧑 用户");
    expect(markdown).toContain("帮我看下登录模块的结构");
    expect(markdown).toContain("## 🤖 助手");
    expect(markdown).toContain("> 💭 **思考**");
    expect(markdown).toContain("> 先看目录结构");
    expect(markdown).toContain("#### 🔧 工具调用：`bash`");
    expect(markdown).toContain('"command": "ls src"');
    expect(markdown).toContain("a.ts\nb.ts");
    // 图片占位且不内联 base64
    expect(markdown).toContain("[📷 图片: image/png");
    expect(markdown).not.toContain("aGVsbG8=");
  });

  it("工具输出超 4000 字符截断并指向 session.jsonl", () => {
    const dir = makeTmp();
    const sm = SessionManager.create("/tmp/proj", dir);
    sm.appendMessage({ role: "user", content: "跑下测试", timestamp: Date.now() });
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "big1", name: "bash", arguments: { command: "pnpm test" } }],
      timestamp: Date.now(),
    } as never);
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "big1",
      toolName: "bash",
      content: [{ type: "text", text: "x".repeat(6000) }],
      isError: false,
      timestamp: Date.now(),
    } as never);
    const { markdown } = renderTranscript(sm.getBranch(), {
      title: "t",
      cwd: "/tmp/proj",
      exportedAt: new Date(),
    });
    expect(markdown).toContain("输出过长已截断，完整内容见 session.jsonl");
    expect(markdown.length).toBeLessThan(6000);
  });

  it("compaction 摘要与 display=false 的注入消息：前者标注、后者不进记录", () => {
    const dir = makeTmp();
    const sm = SessionManager.create("/tmp/proj", dir);
    const firstId = sm.appendMessage({ role: "user", content: "第一条", timestamp: Date.now() });
    sm.appendCompaction("早期讨论了新项目的技术选型", firstId, 50000);
    sm.appendMessage({ role: "user", content: "压缩后的第一条", timestamp: Date.now() });
    sm.appendCustomMessageEntry("spcode-plan-mode", "计划模式已开启（内部约定）", false);
    const { markdown } = renderTranscript(sm.getBranch(), {
      title: "t",
      cwd: "/tmp/proj",
      exportedAt: new Date(),
    });
    expect(markdown).toContain("🗜️ **上下文压缩点**");
    expect(markdown).toContain("早期讨论了新项目的技术选型");
    expect(markdown).toContain("压缩后的第一条");
    expect(markdown).not.toContain("内部约定");
  });
});

describe("buildHandoffPrompt", () => {
  it("包含两个记录文件路径、使用方式指令、工作目录、记忆路径与元信息", () => {
    const text = buildHandoffPrompt({
      transcriptPath: "/e/transcript.md",
      jsonlPath: "/e/session.jsonl",
      cwd: "/tmp/proj",
      title: "登录模块排查",
      messages: 12,
      exportedAt: new Date("2026-01-01T12:00:00"),
      memoryPaths: ["/home/u/.spcode/MEMORY.md", "/home/u/.spcode/memory/projects/proj.md"],
    });
    expect(text).toContain("/e/transcript.md");
    expect(text).toContain("/e/session.jsonl");
    expect(text).toContain("as conversation history that has already taken place between us");
    expect(text).toContain("Working directory: /tmp/proj");
    expect(text).toContain("/home/u/.spcode/MEMORY.md");
    expect(text).toContain("/home/u/.spcode/memory/projects/proj.md");
    expect(text).toContain("登录模块排查");
    expect(text).toContain("12");
    expect(text).toContain("sensitive content");
  });

  it("无记忆文件时省略补充上下文区", () => {
    const text = buildHandoffPrompt({
      transcriptPath: "/e/transcript.md",
      jsonlPath: "/e/session.jsonl",
      cwd: "",
      title: "t",
      messages: 1,
      exportedAt: new Date(),
      memoryPaths: [],
    });
    expect(text).not.toContain("## Additional context");
    expect(text).toContain("Working directory: (no linked directory)");
  });
});

describe("exportSessionContext", () => {
  it("落盘三件套：jsonl 与源文件一致，promptText 与 handoff.md 一致", () => {
    const dir = makeTmp();
    const file = makeSessionFile(dir);
    const home = makeTmp();
    const result = exportSessionContext({
      sessionFile: file,
      cwd: "/tmp/proj",
      title: "登录模块排查",
      spcodeHome: home,
      now: new Date("2026-01-01T12:00:00"),
    });
    expect(result.dir).toContain(join(home, "exports"));
    expect(result.dir).toContain("登录模块排查-20260101-120000");
    // 三件套都存在
    expect(existsSync(result.transcriptPath)).toBe(true);
    expect(existsSync(result.jsonlPath)).toBe(true);
    expect(existsSync(result.promptPath)).toBe(true);
    // jsonl 是源文件整份复制
    expect(readFileSync(result.jsonlPath, "utf-8")).toBe(readFileSync(file, "utf-8"));
    // promptText 与 handoff.md 同内容
    expect(readFileSync(result.promptPath, "utf-8").trim()).toBe(result.promptText.trim());
    // transcript 渲染条数统计
    expect(result.stats.messages).toBe(3);
    expect(result.stats.chars).toBeGreaterThan(100);
  });

  it("会话文件不存在/为空时抛友好错误", () => {
    const home = makeTmp();
    expect(() =>
      exportSessionContext({ sessionFile: join(home, "ghost.jsonl"), cwd: "", title: "t", spcodeHome: home }),
    ).toThrow("还没有可导出的内容");
    const empty = join(home, "empty.jsonl");
    writeFileSync(empty, "");
    expect(() => exportSessionContext({ sessionFile: empty, cwd: "", title: "t", spcodeHome: home })).toThrow(
      "还没有可导出的内容",
    );
  });
});

// ---------------------------------------------------------------------------
// 渲染层 exportSessionContext
// ---------------------------------------------------------------------------

describe("exportSessionContext（渲染层）", () => {
  function stub(clipboardOk: boolean) {
    const command = vi.fn(async () => ({
      dir: "/e/xxx",
      transcriptPath: "/e/xxx/transcript.md",
      jsonlPath: "/e/xxx/session.jsonl",
      promptPath: "/e/xxx/handoff.md",
      promptText: "接力提示词全文",
      stats: { messages: 3, chars: 500 },
    }));
    vi.stubGlobal("window", {
      spcode: {
        onEvent: vi.fn(() => () => {}),
        onUpdateState: vi.fn(() => () => {}),
        updateGetState: vi.fn(async () => ({ status: "idle" })),
        getSettings: vi.fn(async () => ({})),
        listSessions: vi.fn(async () => []),
        getComposerDrafts: vi.fn(async () => ({})),
        setComposerDrafts: vi.fn(async () => {}),
        command,
      },
    });
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: clipboardOk
          ? vi.fn(async () => {})
          : vi.fn(async () => {
              throw new Error("denied");
            }),
      },
    });
    return { command };
  }

  it("成功：复制提示词到剪贴板并 notice 提示导出目录", async () => {
    stub(true);
    useStore.setState((s) => ({
      notice: null,
      registrySessions: [
        {
          id: "e1",
          mode: "chat" as const,
          cwd: "",
          title: "t",
          model: null,
          thinkingLevel: "off",
          sessionFile: "/tmp/e1.jsonl",
          createdAt: 1,
          updatedAt: 1,
        },
        ...s.registrySessions,
      ],
    }));
    await useStore.getState().exportSessionContext("e1");
    const notice = useStore.getState().notice;
    expect(notice?.text).toContain("接力提示词已复制");
    expect(notice?.text).toContain("/e/xxx");
  });

  it("剪贴板失败：notice 兜底指向 handoff.md", async () => {
    stub(false);
    useStore.setState((s) => ({
      notice: null,
      registrySessions: [
        {
          id: "e2",
          mode: "chat" as const,
          cwd: "",
          title: "t",
          model: null,
          thinkingLevel: "off",
          sessionFile: "/tmp/e2.jsonl",
          createdAt: 1,
          updatedAt: 1,
        },
        ...s.registrySessions,
      ],
    }));
    await useStore.getState().exportSessionContext("e2");
    expect(useStore.getState().notice?.text).toContain("handoff.md");
  });
});
