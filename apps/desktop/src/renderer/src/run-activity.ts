/**
 * 一次任务运行的展示切分（纯函数，便于单测）。
 *
 * 一条运行（run）= 用户消息之后连续的 assistant 消息，拍平成一条时间线。
 * 展示规则与 Qoder 一致：连续的思考/工具调用合成一个可折叠的「活动组」，
 * 正文（模型阶段性说明与最终总结）按到达顺序内联在组与组之间。
 * 例如 [思考, 命令, 正文, 思考, 命令, 正文] 会切成
 * 活动组 · 正文 · 活动组 · 正文。
 */

import type { Segment } from "./store";

export type ActivitySegment = Exclude<Segment, { kind: "text" }>;

export type RunBlock =
  | { kind: "text"; key: string; text: string }
  | { kind: "activity"; key: string; segments: ActivitySegment[] };

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
