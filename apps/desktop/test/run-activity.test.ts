/**
 * 运行展示切分单测：连续步骤合成活动组，正文原位内联。
 */
import { describe, expect, it } from "vitest";
import { buildRunBlocks } from "../src/renderer/src/run-activity.js";
import type { Segment } from "../src/renderer/src/store.js";

const thinking = (text = "想一下"): Segment => ({ kind: "thinking", id: "t", text, done: true });
const text = (t: string): Segment => ({ kind: "text", id: `x-${t}`, text: t });
const tools = (name = "read"): Segment => ({
  kind: "tools",
  id: `g-${name}`,
  calls: [{ id: `c-${name}`, name, args: {}, status: "done", output: "" }],
});

const shape = (segments: Segment[]) =>
  buildRunBlocks(segments).map((b) => (b.kind === "text" ? `text:${b.text}` : `activity:${b.segments.length}`));

describe("buildRunBlocks", () => {
  it("只有正文：按到达顺序内联", () => {
    expect(shape([text("第一段"), text("第二段")])).toEqual(["text:第一段", "text:第二段"]);
  });

  it("只有步骤：合成一个活动组", () => {
    expect(shape([thinking(), tools(), tools("edit")])).toEqual(["activity:3"]);
  });

  it("步骤被正文打断时另起一组，正文保持在顺序位置", () => {
    const blocks = buildRunBlocks([thinking(), tools(), text("我先看下"), tools("edit"), text("改好了")]);
    expect(shape([thinking(), tools(), text("我先看下"), tools("edit"), text("改好了")])).toEqual([
      "activity:2",
      "text:我先看下",
      "activity:1",
      "text:改好了",
    ]);
    expect(blocks[0]?.kind === "activity" && blocks[0].segments.map((s) => s.kind)).toEqual(["thinking", "tools"]);
  });

  it("空白正文被丢弃，不打断活动组", () => {
    expect(shape([thinking(), text("   "), tools()])).toEqual(["activity:2"]);
  });

  it("以工具收尾：最后一组仍是活动组", () => {
    expect(shape([text("开始"), tools()])).toEqual(["text:开始", "activity:1"]);
  });
});
