/**
 * 一次任务运行的展示切分（纯函数，双端共用）。
 * 连续的思考/工具调用合成活动组，正文按到达顺序内联；结束后只保留最终总结。
 */

import type { RemoteToolCall } from "@spcode/shared";

export type RunSegment =
  | { kind: "thinking"; id: string; text: string; done: boolean }
  | { kind: "text"; id: string; text: string }
  | { kind: "tools"; id: string; calls: RemoteToolCall[] };

export type ActivitySegment = Exclude<RunSegment, { kind: "text" }>;

export type RunBlock =
  | { kind: "text"; key: string; text: string }
  | { kind: "activity"; key: string; segments: ActivitySegment[] };

export type RunTextBlock = Extract<RunBlock, { kind: "text" }>;

export function buildRunBlocks(segments: RunSegment[]): RunBlock[] {
  const blocks: RunBlock[] = [];
  for (const seg of segments) {
    if (seg.kind === "text") {
      if (!seg.text.trim()) continue;
      blocks.push({ kind: "text", key: seg.id, text: seg.text });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last?.kind === "activity") last.segments.push(seg);
    else blocks.push({ kind: "activity", key: seg.id, segments: [seg] });
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
