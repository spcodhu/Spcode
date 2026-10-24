/**
 * 一次任务运行的展示切分（纯函数，便于单测）。
 *
 * 一条运行（run）= 用户消息之后连续的 assistant 消息，拍平成一条时间线。
 * 展示规则与 Qoder 一致：连续的思考/工具调用合成一个可折叠的「活动组」，
 * 正文（模型阶段性说明与最终总结）按到达顺序内联在组与组之间。
 * 例如 [思考, 命令, 正文, 思考, 命令, 正文] 会切成
 * 活动组 · 正文 · 活动组 · 正文。
 *
 * 任务结束后再把整条时间线切一刀：最后一段正文留在页面上当总结，
 * 其余全部收进「过程」折叠区（见 splitCompletedRun）。
 */

import type { Segment, ToolCallState } from "./store";

export type ActivitySegment = Exclude<Segment, { kind: "text" }>;

export type RunBlock =
  | { kind: "text"; key: string; text: string }
  | { kind: "activity"; key: string; segments: ActivitySegment[] };

export type RunTextBlock = Extract<RunBlock, { kind: "text" }>;

export function buildRunBlocks(segments: Segment[]): RunBlock[] {
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
  /** 收进过程折叠区的阶段正文与活动组（顺序不变） */
  process: RunBlock[];
  /** 留在页面上的最终总结；运行以工具调用收尾时没有 */
  summary?: RunTextBlock;
}

/** 任务结束后：最后一段正文作为总结常驻，其余全部收进过程折叠区 */
export function splitCompletedRun(blocks: RunBlock[]): CompletedRunView {
  const tail = blocks[blocks.length - 1];
  if (tail?.kind !== "text") return { process: blocks };
  return { process: blocks.slice(0, -1), summary: tail };
}

/**
 * 运行中「当前在做什么」，供消息流底部的常驻进度行使用。
 * 活动组被用户收起时，步骤详情不可见，这一行仍要告诉用户当前动作。
 */
export type RunProgressState =
  | { kind: "tool"; call: ToolCallState }
  | { kind: "thinking" }
  | { kind: "output" }
  | { kind: "idle" };

export function currentRunProgress(streamingTail: Segment | undefined): RunProgressState {
  if (streamingTail?.kind === "tools") {
    const running = [...streamingTail.calls].reverse().find((call) => call.status === "running");
    if (running) return { kind: "tool", call: running };
  }
  if (streamingTail?.kind === "thinking" && !streamingTail.done) return { kind: "thinking" };
  if (streamingTail?.kind === "text") return { kind: "output" };
  return { kind: "idle" };
}
