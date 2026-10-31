/**
 * pi 持久化消息 → 手机远程历史块，以及受条数/字节预算约束的分页。
 * 只保留手机现有展示能力所需的文本，不传图片、工具参数或大型工具结果。
 */

import type { RemoteHistoryChunk, RemoteHistoryPage } from "./remote.js";

export const REMOTE_HISTORY_PAGE_CHUNKS = 80;
export const REMOTE_HISTORY_PAGE_BYTES = 96 * 1024;
export const REMOTE_HISTORY_TEXT_BYTES = 8 * 1024;

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** 按 UTF-8 字节预算切分，按码点迭代避免切断 surrogate pair。 */
function splitText(text: string): string[] {
  if (byteLength(text) <= REMOTE_HISTORY_TEXT_BYTES) return [text];
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of text) {
    const size = byteLength(char);
    if (current && bytes + size > REMOTE_HISTORY_TEXT_BYTES) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  if (current) out.push(current);
  return out;
}

function textBlocks(content: unknown): { type: string; text: string }[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const b = block as { type?: unknown; text?: unknown; thinking?: unknown };
    if (b.type === "text" && typeof b.text === "string" && b.text) return [{ type: "text", text: b.text }];
    if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking) {
      return [{ type: "thinking", text: b.thinking }];
    }
    return [];
  });
}

/** 保持用户/助手/thinking 原顺序与原文；不翻译、不摘要、不重写模型内容。 */
export function historyToRemoteChunks(messages: unknown[]): RemoteHistoryChunk[] {
  const out: RemoteHistoryChunk[] = [];
  const push = (kind: RemoteHistoryChunk["kind"], text: string) => {
    for (const chunk of splitText(text)) out.push({ kind, chunk });
  };

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as {
      role?: unknown;
      content?: unknown;
      summary?: unknown;
      stopReason?: unknown;
      errorMessage?: unknown;
    };
    if (message.role === "user") {
      const text = textBlocks(message.content)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (text) push("user", text);
      continue;
    }
    if (message.role === "assistant") {
      for (const block of textBlocks(message.content))
        push(block.type === "thinking" ? "thinking" : "text", block.text);
      if (message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.trim()) {
        push("notice", message.errorMessage.trim());
      }
      continue;
    }
    if (message.role === "compactionSummary" && typeof message.summary === "string" && message.summary) {
      push("notice", message.summary);
    }
  }
  return out;
}

function normalizeBefore(before: number | undefined, length: number): number {
  if (before === undefined || !Number.isFinite(before)) return length;
  return Math.max(0, Math.min(length, Math.floor(before)));
}

/** before 是“最早已加载块”的全量下标；返回更早一段，游标不含本页，翻页不会重复。 */
export function historyToRemotePage(messages: unknown[], before?: number): Omit<RemoteHistoryPage, "outputSeq"> {
  const all = historyToRemoteChunks(messages);
  const end = normalizeBefore(before, all.length);
  let start = end;
  let bytes = 0;
  while (start > 0 && end - start < REMOTE_HISTORY_PAGE_CHUNKS) {
    const size = byteLength(all[start - 1]!.chunk) + 32;
    if (start < end && bytes + size > REMOTE_HISTORY_PAGE_BYTES) break;
    start--;
    bytes += size;
  }
  return {
    chunks: all.slice(start, end),
    olderBefore: start > 0 ? start : null,
  };
}
