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
import { getLocale, i18n } from "@spcode/shared/i18n";
import { buildLanguagePolicy } from "./language-policy.js";
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
    return `${raw.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n${i18n.t("agent:export.truncated")}`;
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
    `# ${i18n.t("agent:export.title", { title: meta.title })}`,
    "",
    `- ${i18n.t("agent:export.exportedAt", { time: meta.exportedAt.toLocaleString(getLocale()) })}`,
    `- ${i18n.t("agent:export.cwd", { cwd: meta.cwd || i18n.t("agent:export.noCwd") })}`,
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
          parts.push("", `## 🧑 ${i18n.t("agent:export.user")}`, "");
          if (text) parts.push(text);
          for (const img of images)
            parts.push(`[📷 ${i18n.t("agent:export.image", { mimeType: img.mimeType || "image/png" })}]`);
        } else if (m.role === "assistant") {
          const blocks = Array.isArray(m.content) ? (m.content as ContentBlock[]) : [];
          const rendered: string[] = [];
          for (const b of blocks) {
            if (b.type === "thinking" && b.thinking?.trim()) {
              rendered.push(`> 💭 **${i18n.t("agent:export.thinking")}**\n${quoteBlock(b.thinking.trim())}`);
            } else if (b.type === "text" && b.text?.trim()) {
              rendered.push(b.text.trim());
            } else if (b.type === "toolCall" && b.name) {
              const args = JSON.stringify(b.arguments ?? {}, null, 2);
              const res = b.id ? toolResults.get(b.id) : undefined;
              const block = [
                `#### 🔧 ${i18n.t("agent:export.toolCall", { name: b.name })}`,
                "",
                i18n.t("agent:export.arguments"),
                "```json",
                args,
                "```",
              ];
              if (res) {
                block.push(
                  "",
                  i18n.t(res.isError ? "agent:export.errorResult" : "agent:export.result"),
                  "```",
                  res.text || i18n.t("agent:export.noOutput"),
                  "```",
                );
              } else {
                block.push("", i18n.t("agent:export.missingResult"));
              }
              rendered.push(block.join("\n"));
            }
          }
          if (rendered.length === 0) break;
          messages++;
          parts.push("", `## 🤖 ${i18n.t("agent:export.assistant")}`, "", rendered.join("\n\n"));
        }
        // system / toolResult 消息不单独渲染（toolResult 已关联到工具调用下）
        break;
      }
      case "compaction":
        parts.push(
          "",
          "---",
          "",
          `> 🗜️ ${i18n.t("agent:export.compaction", { time: new Date(e.timestamp).toLocaleString(getLocale()), tokens: e.tokensBefore })}`,
          "",
          quoteBlock(e.summary),
          "",
          "---",
        );
        break;
      case "branch_summary":
        parts.push("", `> 🔀 ${i18n.t("agent:export.branchSummary")}`, "", quoteBlock(e.summary));
        break;
      case "model_change":
        parts.push("", `*📌 ${i18n.t("agent:export.modelChange", { provider: e.provider, model: e.modelId })}*`);
        break;
      case "thinking_level_change":
        parts.push("", `*📌 ${i18n.t("agent:export.thinkingChange", { level: e.thinkingLevel })}*`);
        break;
      case "custom_message": {
        // display=false 的是 harness 内部机制消息（计划模式约定等），不进记录
        if (!e.display) break;
        const text = typeof e.content === "string" ? e.content : textOf(e.content);
        if (text.trim())
          parts.push("", `## 📎 ${i18n.t("agent:export.customMessage", { type: e.customType })}`, "", text.trim());
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
    "You are taking over a complete conversation from another AI coding assistant (Spcode).",
    "",
    "## Session record locations (local files; use your file-reading tools)",
    `- Human-readable transcript: ${opts.transcriptPath} — read it in full first`,
    `- Structured original record: ${opts.jsonlPath} — one JSON event per line (messages/tool calls/usage/compaction boundaries); consult it for exact tool arguments or original output`,
    "",
    "## How to continue",
    "- Treat transcript.md as conversation history that has already taken place between us. Do not repeat completed work, established conclusions, or file reads.",
    "- After reading, confirm the current progress and next step in one or two sentences, then wait for my instructions.",
    `- Working directory: ${opts.cwd || "(no linked directory)"}`,
    "",
    buildLanguagePolicy(),
  ];
  if (opts.memoryPaths.length > 0) {
    lines.push("", "## Additional context (local Spcode memory; read as needed)");
    for (const p of opts.memoryPaths) lines.push(`- ${p}`);
  }
  lines.push(
    "",
    "## Session metadata",
    `- Title: ${opts.title} · Exported at: ${opts.exportedAt.toISOString()} · Conversation messages: ${opts.messages}`,
    "- Caution: records may contain sensitive content such as command output. Use them only for this work; do not share them externally.",
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
    throw new Error(i18n.t("agent:export.empty"));
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
