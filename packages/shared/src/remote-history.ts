/**
 * pi 持久化消息 → 手机远程输出块，以及受条数/字节预算约束的分页。
 * 文本保持原顺序与原文；工具调用与结果合并为一步步快照，不传图片载荷。
 */

import type { RemoteHistoryChunk, RemoteHistoryPage, RemoteToolCall } from "./remote.js";

export const REMOTE_HISTORY_PAGE_CHUNKS = 80;
export const REMOTE_HISTORY_PAGE_BYTES = 96 * 1024;
export const REMOTE_HISTORY_TEXT_BYTES = 8 * 1024;
export const REMOTE_TOOL_OUTPUT_CHARS = 8 * 1024;
export const REMOTE_TOOL_PATCH_CHARS = 12 * 1024;

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

/** 与桌面历史回放一致：优先文本 content，其次 JSON 摘要；远程传输限制长度。 */
export function remoteToolResultText(result: unknown): string {
  let text: string;
  if (result == null) return "";
  if (typeof result === "string") text = result;
  else {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      text = content
        .flatMap((block) => {
          if (!block || typeof block !== "object") return [];
          const b = block as { type?: unknown; text?: unknown };
          return b.type === "text" && typeof b.text === "string" && b.text ? [b.text] : [];
        })
        .join("\n");
    } else {
      try {
        text = JSON.stringify(result) ?? String(result);
      } catch {
        text = String(result);
      }
    }
  }
  return text.slice(0, REMOTE_TOOL_OUTPUT_CHARS);
}

export function remoteToolPatch(result: unknown): string | undefined {
  const patch = (result as { details?: { patch?: unknown } } | null)?.details?.patch;
  return typeof patch === "string" && patch ? patch.slice(0, REMOTE_TOOL_PATCH_CHARS) : undefined;
}

interface RemoteToolResult {
  output: string;
  isError: boolean;
  patch?: string;
}

/** 保持用户/助手/thinking/工具原顺序；工具结果按 toolCallId 回填到调用步骤。 */
export function historyToRemoteChunks(messages: unknown[]): RemoteHistoryChunk[] {
  const out: RemoteHistoryChunk[] = [];
  const toolResults = new Map<string, RemoteToolResult>();
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as { role?: unknown; toolCallId?: unknown; isError?: unknown };
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    toolResults.set(message.toolCallId, {
      output: remoteToolResultText(raw),
      isError: message.isError === true,
      ...(remoteToolPatch(raw) ? { patch: remoteToolPatch(raw) } : {}),
    });
  }

  const push = (kind: RemoteHistoryChunk["kind"], text: string) => {
    for (const chunk of splitText(text)) out.push({ kind, chunk });
  };
  const pushTool = (tool: RemoteToolCall) => out.push({ kind: "tool", chunk: "", tool });

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
      if (Array.isArray(message.content)) {
        for (const rawBlock of message.content) {
          if (!rawBlock || typeof rawBlock !== "object") continue;
          const block = rawBlock as {
            type?: unknown;
            text?: unknown;
            thinking?: unknown;
            id?: unknown;
            name?: unknown;
            arguments?: unknown;
          };
          if (block.type === "text" && typeof block.text === "string" && block.text) push("text", block.text);
          else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
            push("thinking", block.thinking);
          } else if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
            const result = toolResults.get(block.id);
            pushTool({
              id: block.id,
              name: block.name,
              args: block.arguments,
              status: result ? (result.isError ? "error" : "done") : "running",
              output: result?.output ?? "",
              ...(result?.patch ? { patch: result.patch } : {}),
            });
          }
        }
      }
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

function chunkBytes(chunk: RemoteHistoryChunk): number {
  return byteLength(chunk.chunk) + (chunk.tool ? byteLength(JSON.stringify(chunk.tool)) : 0) + 32;
}

/** before 是“最早已加载块”的全量下标；返回更早一段，游标不含本页，翻页不会重复。 */
export function historyToRemotePage(messages: unknown[], before?: number): Omit<RemoteHistoryPage, "outputSeq"> {
  const all = historyToRemoteChunks(messages);
  const end = normalizeBefore(before, all.length);
  let start = end;
  let bytes = 0;
  while (start > 0 && end - start < REMOTE_HISTORY_PAGE_CHUNKS) {
    const size = chunkBytes(all[start - 1]!);
    if (start < end && bytes + size > REMOTE_HISTORY_PAGE_BYTES) break;
    start--;
    bytes += size;
  }
  return {
    chunks: all.slice(start, end),
    olderBefore: start > 0 ? start : null,
  };
}
