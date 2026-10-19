/**
 * 一次任务运行的展示规划（纯函数，便于单测）。
 *
 * 背景：一条运行（run）= 用户消息之后连续的 assistant 消息，拍平成一条时间线。
 * 之前无论运行中还是结束后，所有正文（阶段化输出）都内联渲染，
 * 任务结束后中间轮次的「我先看下…」「已改好…」会和最终总结混在一起，
 * 干扰阅读；也没有「只看最新一次输出」的 Codex 式精简模式。
 *
 * 这里把段分成两组：
 * - work：折叠进「工作完成」时间线的部分（思考 / 工具 / 中间阶段输出）
 * - inline：常驻渲染的正文（最终总结；运行中保持全部正文可见）
 */

import type { Segment } from "./store";

export type ActivityDisplay = "full" | "compact";

export interface RunView {
  work: Segment[];
  inline: Segment[];
  /** 运行中/结束后被折叠或隐藏的条目数（折叠按钮与「查看完整过程」文案用） */
  foldedCount: number;
  /** 被折叠的阶段化输出段数（>=2 时行头提示「含 N 段过程输出」） */
  stageCount: number;
  /** 紧凑模式下隐藏了内容（需要「查看完整过程」入口） */
  hiddenInCompact: boolean;
}

function hasText(seg: Segment): seg is Extract<Segment, { kind: "text" }> {
  return seg.kind === "text" && seg.text.trim().length > 0;
}

/** 最后一个有内容的正文段的下标（没有则 -1） */
function lastTextIndex(segments: Segment[]): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg && hasText(seg)) return i;
  }
  return -1;
}

export function partitionRun(
  segments: Segment[],
  opts: { active: boolean; mode: ActivityDisplay; forceFull?: boolean },
): RunView {
  // 先剔掉空正文段：否则“最后一个 text 是空白”会把之后的工具段一起丢掉
  const segs = segments.filter((s) => s.kind !== "text" || s.text.trim().length > 0);
  const mode = opts.forceFull ? "full" : opts.mode;
  const last = lastTextIndex(segs);

  // 运行中：完整模式保持「正文原位、思考/工具折叠」；精简模式只留最新一段输出
  if (mode === "compact") {
    const inline = last >= 0 ? [segs[last] as Segment] : [];
    return {
      work: [],
      inline,
      foldedCount: segs.length - inline.length,
      stageCount: 0,
      hiddenInCompact: segs.length > inline.length,
    };
  }

  if (opts.active) {
    const work = segs.filter((s) => !hasText(s));
    const inline = segs.filter(hasText);
    return {
      work,
      inline,
      foldedCount: work.length,
      stageCount: 0,
      hiddenInCompact: false,
    };
  }

  // 结束后：只把最后一段正文当总结，其余（含中间阶段输出）全部收进工作时间线。
  // 注意用「排除」而不是「切前面」：运行可能以工具调用收尾（最后一段正文之后
  // 还有工具段），切前面会把它们丢掉。
  const inline = last >= 0 ? [segs[last] as Segment] : [];
  const work = last >= 0 ? segs.filter((_, i) => i !== last) : [...segs];
  const stageCount = work.filter(hasText).length;
  return {
    work,
    inline,
    foldedCount: work.length,
    stageCount,
    hiddenInCompact: false,
  };
}
