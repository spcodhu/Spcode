/**
 * 运行展示规划单测：两档模式 × 运行中/结束后 × 有无正文/以工具收尾。
 */
import { describe, expect, it } from "vitest";
import { partitionRun } from "../src/renderer/src/run-view.js";
import type { Segment } from "../src/renderer/src/store.js";

const thinking = (text = "想一下"): Segment => ({ kind: "thinking", id: "t", text, done: true });
const text = (t: string): Segment => ({ kind: "text", id: `x-${t}`, text: t });
const tools = (name = "read"): Segment => ({
  kind: "tools",
  id: "g",
  calls: [{ id: `c-${name}`, name, args: {}, status: "done", output: "" }],
});

const kinds = (segs: Segment[]) => segs.map((s) => s.kind);
const textOf = (segs: Segment[]) => segs.map((s) => (s.kind === "text" ? s.text : "")).join("|");

describe("partitionRun · 完整模式", () => {
  it("运行中：正文内联，思考/工具折叠（与旧行为一致）", () => {
    const segs = [thinking(), text("我先看下"), tools(), text("改好了")];
    const view = partitionRun(segs, { active: true, mode: "full" });
    expect(kinds(view.inline)).toEqual(["text", "text"]);
    expect(kinds(view.work)).toEqual(["thinking", "tools"]);
    expect(view.stageCount).toBe(0);
  });

  it("结束后：只留最后一段正文，之前的思考/工具/中间输出全进折叠区", () => {
    const segs = [thinking(), text("我先看下"), tools(), text("改好了"), tools("edit"), text("总结如下…")];
    const view = partitionRun(segs, { active: false, mode: "full" });
    expect(textOf(view.inline)).toBe("总结如下…");
    // 折叠区保留原有到达顺序；中间那段阶段输出也算折叠项
    expect(kinds(view.work)).toEqual(["thinking", "text", "tools", "text", "tools"]);
    expect(view.stageCount).toBe(2);
    expect(view.foldedCount).toBe(5);
  });

  it("结束后只有一段正文：无需折叠（不会平白多出一个「工作完成」）", () => {
    const segs = [text("直接回答")];
    const view = partitionRun(segs, { active: false, mode: "full" });
    expect(textOf(view.inline)).toBe("直接回答");
    expect(view.work).toHaveLength(0);
  });

  it("结束后以工具收尾（没有正文）：全部内容收进折叠区", () => {
    const segs = [thinking(), tools()];
    const view = partitionRun(segs, { active: false, mode: "full" });
    expect(view.inline).toHaveLength(0);
    expect(kinds(view.work)).toEqual(["thinking", "tools"]);
  });

  it("空白正文段被丢弃，不会把之后的工具段一起弄丢", () => {
    const segs = [text("中间输出"), tools(), text("   ")];
    const view = partitionRun(segs, { active: false, mode: "full" });
    expect(textOf(view.inline)).toBe("中间输出");
    expect(kinds(view.work)).toEqual(["tools"]);
  });
});

describe("partitionRun · 精简模式（类 Codex）", () => {
  it("只展示最新一次阶段化输出，思考与命令全部隐藏", () => {
    const segs = [thinking(), text("我先看下"), tools(), text("已经改完了")];
    const view = partitionRun(segs, { active: true, mode: "compact" });
    expect(textOf(view.inline)).toBe("已经改完了");
    expect(view.work).toHaveLength(0);
    expect(view.hiddenInCompact).toBe(true);
    expect(view.foldedCount).toBe(3);
  });

  it("最新一步是工具调用：仍展示最近一段正文，不闪成空白", () => {
    const segs = [text("开始"), tools()];
    const view = partitionRun(segs, { active: true, mode: "compact" });
    expect(textOf(view.inline)).toBe("开始");
    expect(view.hiddenInCompact).toBe(true);
  });

  it("没有任何正文：inline 为空，但标记有隐藏内容", () => {
    const view = partitionRun([thinking(), tools()], { active: true, mode: "compact" });
    expect(view.inline).toHaveLength(0);
    expect(view.hiddenInCompact).toBe(true);
  });

  it("forceFull 临时切回完整视图", () => {
    const segs = [thinking(), text("阶段一"), tools(), text("最终总结")];
    const compact = partitionRun(segs, { active: false, mode: "compact" });
    expect(textOf(compact.inline)).toBe("最终总结");
    expect(compact.work).toHaveLength(0);
    const full = partitionRun(segs, { active: false, mode: "compact", forceFull: true });
    expect(textOf(full.inline)).toBe("最终总结");
    expect(kinds(full.work)).toEqual(["thinking", "text", "tools"]);
  });
});
