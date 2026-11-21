/**
 * 一次任务运行的展示切分（纯函数，双端共用）。
 * 正文、思考与同名工具组按到达顺序平级排列；结束后仅分离末尾正文作为总结。
 */

import type { RemoteToolCall } from "@spcode/shared";

export type RunSegment =
  | { kind: "thinking"; id: string; text: string; done: boolean }
  | { kind: "text"; id: string; text: string }
  | { kind: "tools"; id: string; calls: RemoteToolCall[] };

export type RunBlock =
  | { kind: "text"; key: string; text: string }
  | { kind: "thinking"; key: string; text: string; done: boolean }
  | { kind: "tools"; key: string; calls: RemoteToolCall[] };

export type RunTextBlock = Extract<RunBlock, { kind: "text" }>;

export function buildRunBlocks(segments: RunSegment[]): RunBlock[] {
  const blocks: RunBlock[] = [];
  for (const seg of segments) {
    if (seg.kind === "text") {
      if (!seg.text.trim()) continue;
      blocks.push({ kind: "text", key: seg.id, text: seg.text });
      continue;
    }
    if (seg.kind === "thinking") {
      if (seg.done && !seg.text.trim()) continue;
      blocks.push({ kind: "thinking", key: seg.id, text: seg.text, done: seg.done });
      continue;
    }
    for (const call of seg.calls) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "tools" && last.calls[0]?.name.toLowerCase() === call.name.toLowerCase()) {
        last.calls.push(call);
      } else {
        blocks.push({ kind: "tools", key: `tools:${call.id}`, calls: [call] });
      }
    }
  }
  return blocks;
}

export interface CompletedRunView {
  process: RunBlock[];
  summary?: RunTextBlock;
}

export function splitCompletedRun(blocks: RunBlock[]): CompletedRunView {
  const tail = blocks[blocks.length - 1];
  if (tail?.kind !== "text") return { process: blocks };
  return { process: blocks.slice(0, -1), summary: tail };
}

export type RunProgressState =
  | { kind: "tool"; call: RemoteToolCall }
  | { kind: "thinking" }
  | { kind: "output" }
  | { kind: "idle" };

export function currentRunProgress(streamingTail: RunSegment | undefined): RunProgressState {
  if (streamingTail?.kind === "tools") {
    const running = [...streamingTail.calls].reverse().find((call) => call.status === "running");
    if (running) return { kind: "tool", call: running };
  }
  if (streamingTail?.kind === "thinking" && !streamingTail.done) return { kind: "thinking" };
  if (streamingTail?.kind === "text") return { kind: "output" };
  return { kind: "idle" };
}
