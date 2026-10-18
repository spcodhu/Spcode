/**
 * 会话上下文导出（handoff）：把会话记录落盘到 ~/.spcode/exports/<slug>-<ts>/，
 * 并生成给下一个 AI 助手的接力提示词（渲染层复制到剪贴板；同内容落盘 handoff.md 兜底）。
 *
 * 设计依据：不做格式转换，让下一个 harness 用自己的文件读取能力"原生恢复"
 * （Harness Mix 跨工具接力的同款思路）——transcript.md 给所有 harness 和人读，
 * session.jsonl 保留 pi 原始结构（消息/工具调用/用量/压缩边界）供精确查阅。
 *
 * 与 pi 官方 /export 一致的安全口径：导出件可能含密钥/命令输出等敏感内容，
 * 提示词与 UI 提示都要求先检查再分享（本期不做自动脱敏）。
 */
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExportContextResult } from "@spcode/shared";
import { MemoryStore } from "./memory-store.js";

/** 单条工具输出在 transcript 里的上限（超出截断并指向 session.jsonl） */
const MAX_TOOL_OUTPUT_CHARS = 4000;

/** 导出目录名用的 slug：与 MemoryStore.projectSlug 同口径（Unicode 字母/数字/._-） */
function slugify(text: string): string {
  const slug = text
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return slug || "session";
}

/** yyyymmdd-hhmmss（本地时区，导出目录名用） */
function formatTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Markdown 引用块（每行加 "> " 前缀） */
function quoteBlock(text: string): string {
  return text
    .split("\n")
    .map((l) => (l.trim() ? `> ${l}` : ">"))
    .join("\n");
}

// ---------------------------------------------------------------------------
// transcript.md 渲染
// ---------------------------------------------------------------------------

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  data?: string;
  mimeType?: string;
}

interface ToolResultInfo {
  text: string;
  isError: boolean;
}

/** 从消息 content 块里提取纯文本（type=text 的块拼接） */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n");
}

/** toolResult 消息 → 可读输出文本（超上限截断，指向 session.jsonl） */
function toolResultText(msg: { content?: unknown }): string {
  const raw = textOf(msg.content);
  if (raw.length > MAX_TOOL_OUTPUT_CHARS) {
    return `${raw.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…（输出过长已截断，完整内容见 session.jsonl）`;
  }
  return raw;
}

/**
 * 把会话当前分支的全部 entries 渲染成 Markdown 对话记录。
 * 渲染的是 getBranch() 的完整路径（含被压缩前的原始消息、压缩点摘要、分支摘要），
 * 系统提示（system 消息）与 harness 内部机制消息（display=false 的 custom_message）不渲染。
 * 返回 Markdown 文本与渲染出的对话消息条数（user + assistant）。
 * 导出供单测。
 */
export function renderTranscript(
  entries: SessionEntry[],
  meta: { title: string; cwd: string; exportedAt: Date },
): { markdown: string; messages: number } {
  // 预扫描 toolResult（toolCall 在 assistant 消息里，结果在后续独立消息里，两遍法关联）
  const toolResults = new Map<string, ToolResultInfo>();
  for (const e of entries) {
    if (e.type !== "message") continue;
    const m = e.message as { role?: string; toolCallId?: string; isError?: boolean; content?: unknown };
    if (m.role === "toolResult" && m.toolCallId) {
      toolResults.set(m.toolCallId, { text: toolResultText(m), isError: !!m.isError });
    }
  }

  const parts: string[] = [
    `# 会话记录：${meta.title}`,
    "",
    `- 导出时间：${meta.exportedAt.toLocaleString("zh-CN")}`,
    `- 工作目录：${meta.cwd || "（无绑定目录）"}`,
    "",
    "---",
  ];
  let messages = 0;

  for (const e of entries) {
    switch (e.type) {
      case "message": {
        const m = e.message as { role?: string; content?: unknown };
        if (m.role === "user") {
          const blocks = Array.isArray(m.content) ? (m.content as ContentBlock[]) : [];
          const text = textOf(m.content).trim();
          const images = blocks.filter((b) => b.type === "image");
          if (!text && images.length === 0) break;
          messages++;
          parts.push("", "## 🧑 用户", "");
          if (text) parts.push(text);
          for (const img of images)
            parts.push(`[📷 图片: ${img.mimeType || "image/png"}，未内联——原图见 session.jsonl]`);
        } else if (m.role === "assistant") {
          const blocks = Array.isArray(m.content) ? (m.content as ContentBlock[]) : [];
          const rendered: string[] = [];
          for (const b of blocks) {
            if (b.type === "thinking" && b.thinking?.trim()) {
              rendered.push(`> 💭 **思考**\n${quoteBlock(b.thinking.trim())}`);
            } else if (b.type === "text" && b.text?.trim()) {
              rendered.push(b.text.trim());
            } else if (b.type === "toolCall" && b.name) {
              const args = JSON.stringify(b.arguments ?? {}, null, 2);
              const res = b.id ? toolResults.get(b.id) : undefined;
              const block = [`#### 🔧 工具调用：\`${b.name}\``, "", "参数：", "```json", args, "```"];
              if (res) {
                block.push("", `结果${res.isError ? "（错误）" : ""}：`, "```", res.text || "（无输出）", "```");
              } else {
                block.push("", "结果：（未记录——调用被中断或会话被截断）");
              }
              rendered.push(block.join("\n"));
            }
          }
          if (rendered.length === 0) break;
          messages++;
          parts.push("", "## 🤖 助手", "", rendered.join("\n\n"));
        }
        // system / toolResult 消息不单独渲染（toolResult 已关联到工具调用下）
        break;
      }
      case "compaction":
        parts.push(
          "",
          "---",
          "",
          `> 🗜️ **上下文压缩点**（${new Date(e.timestamp).toLocaleString("zh-CN")}）：约 ${e.tokensBefore} tokens 的早期历史被压缩为以下摘要：`,
          "",
          quoteBlock(e.summary),
          "",
          "---",
        );
        break;
      case "branch_summary":
        parts.push("", `> 🔀 **分支摘要**（另一条探索路径并入主线）：`, "", quoteBlock(e.summary));
        break;
      case "model_change":
        parts.push("", `*📌 模型切换：${e.provider}/${e.modelId}*`);
        break;
      case "thinking_level_change":
        parts.push("", `*📌 思考档位切换：${e.thinkingLevel}*`);
        break;
      case "custom_message": {
        // display=false 的是 harness 内部机制消息（计划模式约定等），不进记录
        if (!e.display) break;
        const text = typeof e.content === "string" ? e.content : textOf(e.content);
        if (text.trim()) parts.push("", `## 📎 注入消息（${e.customType}）`, "", text.trim());
        break;
      }
      default:
        // usage / label / session_info / context_edit / custom 状态条目不进对话记录
        break;
    }
  }

  return { markdown: `${parts.join("\n")}\n`, messages };
}

// ---------------------------------------------------------------------------
// handoff 接力提示词
// ---------------------------------------------------------------------------

/**
 * 生成给下一个 AI 助手的接力提示词：指明完整会话记录的位置，
 * 指示它把读到的内容当作已经完整发生过的会话历史。导出供单测。
 */
export function buildHandoffPrompt(opts: {
  transcriptPath: string;
  jsonlPath: string;
  cwd: string;
  title: string;
  messages: number;
  exportedAt: Date;
  /** 本机全局记忆文件路径（SOUL/MEMORY/项目记忆，存在才传） */
  memoryPaths: string[];
}): string {
  const lines = [
    "你正在接手一段来自另一个 AI 编程助手（Spcode）的完整会话。",
    "",
    "## 会话记录位置（都在本机，用你的文件读取工具读）",
    `- 人类可读记录：${opts.transcriptPath} —— 先完整读取它`,
    `- 结构化原始记录：${opts.jsonlPath} —— 每行一个 JSON 事件（消息/工具调用/用量/压缩边界），需要工具参数、原始输出等精确细节时查阅`,
    "",
    "## 使用方式",
    "- 把 transcript.md 的内容当作你我之间已经完整发生过的会话历史：不要重复其中已完成的工作、已得出的结论、已读过的文件。",
    "- 读完后用一两句话向我确认你掌握到的当前进展与下一步，然后等我的指令继续。",
    `- 工作目录：${opts.cwd || "（无绑定目录）"}`,
  ];
  if (opts.memoryPaths.length > 0) {
    lines.push("", "## 补充上下文（本机 Spcode 全局记忆，可按需读取）");
    for (const p of opts.memoryPaths) lines.push(`- ${p}`);
  }
  lines.push(
    "",
    "## 会话元信息",
    `- 标题：${opts.title} · 导出时间：${opts.exportedAt.toLocaleString("zh-CN")} · 对话消息条数：${opts.messages}`,
    "- 注意：记录中可能包含命令输出等敏感内容，仅用于本次工作，不要外传。",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 导出主流程
// ---------------------------------------------------------------------------

/** 收集本机全局记忆文件路径（存在才列出；项目记忆按 cwd slug 定位） */
function collectMemoryPaths(spcodeHome: string, cwd: string): string[] {
  const paths: string[] = [];
  const memoryMd = join(spcodeHome, "MEMORY.md");
  if (existsSync(memoryMd)) paths.push(memoryMd);
  if (cwd.trim()) {
    const projectFile = join(spcodeHome, "memory", "projects", `${MemoryStore.projectSlug(cwd)}.md`);
    if (existsSync(projectFile)) paths.push(projectFile);
  }
  return paths;
}

/**
 * 导出会话上下文三件套 + 接力提示词。
 * 纯文件操作（SessionManager.open 只读解析，不创建 AgentSession、不触碰模型运行时），
 * 源会话处于休眠/运行中都可导出（append-only 文件读到的是导出时刻快照）。
 * 会话文件不存在/为空时抛错（调用方转成友好提示）。
 */
export function exportSessionContext(opts: {
  sessionFile: string;
  cwd: string;
  title: string;
  spcodeHome: string;
  now?: Date;
}): ExportContextResult {
  if (!existsSync(opts.sessionFile) || statSync(opts.sessionFile).size === 0) {
    throw new Error("该会话还没有可导出的内容（会话记录为空）");
  }
  const now = opts.now ?? new Date();
  const dir = join(opts.spcodeHome, "exports", `${slugify(opts.title)}-${formatTimestamp(now)}`);
  mkdirSync(dir, { recursive: true });

  // 1. 原始完整记录：整文件复制（含所有分支/compaction/usage，不丢任何东西）
  const jsonlPath = join(dir, "session.jsonl");
  copyFileSync(opts.sessionFile, jsonlPath);

  // 2. 人类可读记录：当前活跃分支的全部消息渲染为 Markdown
  const sessionManager = SessionManager.open(opts.sessionFile);
  const { markdown, messages } = renderTranscript(sessionManager.getBranch(), {
    title: opts.title,
    cwd: opts.cwd,
    exportedAt: now,
  });
  const transcriptPath = join(dir, "transcript.md");
  writeFileSync(transcriptPath, markdown, "utf-8");

  // 3. 接力提示词：返回给渲染层复制到剪贴板，同内容落盘 handoff.md 兜底
  const promptText = buildHandoffPrompt({
    transcriptPath,
    jsonlPath,
    cwd: opts.cwd,
    title: opts.title,
    messages,
    exportedAt: now,
    memoryPaths: collectMemoryPaths(opts.spcodeHome, opts.cwd),
  });
  const promptPath = join(dir, "handoff.md");
  writeFileSync(promptPath, `${promptText}\n`, "utf-8");

  return { dir, transcriptPath, jsonlPath, promptPath, promptText, stats: { messages, chars: markdown.length } };
}
