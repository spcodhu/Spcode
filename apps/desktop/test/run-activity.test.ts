/** 平级时间线：严格保序、仅合并相邻同名工具，结束后仅分离末尾正文。 */
import type { RemoteToolCall } from "@spcode/shared";
import { describe, expect, it } from "vitest";
import type { RunBlock, RunSegment } from "../src/renderer/src/run-activity.js";
import { buildRunBlocks, currentRunProgress, splitCompletedRun } from "../src/renderer/src/run-activity.js";

const thinking = (text = "想一下", done = true, id = "t"): RunSegment => ({ kind: "thinking", id, text, done });
const text = (text: string, id = `x-${text}`): RunSegment => ({ kind: "text", id, text });
const call = (id: string, name = "read", status: RemoteToolCall["status"] = "done"): RemoteToolCall => ({
  id,
  name,
  args: { path: `${id}.ts` },
  status,
  output: `${id} output`,
});
const tools = (calls: RemoteToolCall[] = [call("c-read")], id = "g"): RunSegment => ({ kind: "tools", id, calls });
const shape = (blocks: RunBlock[]) =>
  blocks.map((b) => (b.kind === "tools" ? `tools:${b.calls.map((c) => c.id).join(",")}` : `${b.kind}:${b.text}`));

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

describe("buildRunBlocks", () => {
  it("正文、思考、工具三类平级，严格按到达顺序保留", () => {
    const blocks = buildRunBlocks([
      text("开始"),
      thinking("分析", false),
      tools([call("read-1")]),
      thinking("继续分析", true, "t2"),
      tools([call("edit-1", "edit")]),
      text("完成"),
    ]);
    expect(shape(blocks)).toEqual([
      "text:开始",
      "thinking:分析",
      "tools:read-1",
      "thinking:继续分析",
      "tools:edit-1",
      "text:完成",
    ]);
    expect(blocks[1]).toEqual({ kind: "thinking", key: "t", text: "分析", done: false });
    expect(blocks[3]).toEqual({ kind: "thinking", key: "t2", text: "继续分析", done: true });
  });

  it("同一 segment 以及跨 segment 的相邻同名工具均按大小写标准化合并", () => {
    const calls = [call("r1", "Read"), call("r2", "read"), call("r3", "READ"), call("r4", "Read")];
    const blocks = buildRunBlocks([tools(calls.slice(0, 2), "g1"), tools(calls.slice(2), "g2")]);
    expect(blocks).toEqual([{ kind: "tools", key: "tools:r1", calls }]);
    expect(calls.map((c) => c.name)).toEqual(["Read", "read", "READ", "Read"]);
  });

  it("不同工具各起一块，相隔的同名工具不重排或合并", () => {
    const blocks = buildRunBlocks([
      tools([call("r1"), call("e1", "edit"), call("r2")], "g1"),
      tools([call("b1", "bash"), call("s1", "shell")], "g2"),
    ]);
    expect(shape(blocks)).toEqual(["tools:r1", "tools:e1", "tools:r2", "tools:b1", "tools:s1"]);
    expect(new Set(blocks.map((b) => b.key)).size).toBe(5);
  });

  it.each([text("说明"), thinking("分析"), thinking("流式分析", false), thinking("", false)])(
    "同名工具不跨正文或保留的思考段合并：%j",
    (separator) => {
      const blocks = buildRunBlocks([tools([call("r1")]), separator, tools([call("r2")])]);
      expect(blocks).toHaveLength(3);
      expect(shape(blocks)[0]).toBe("tools:r1");
      expect(blocks[1].kind).toBe(separator.kind);
      expect(shape(blocks)[2]).toBe("tools:r2");
    },
  );

  it("相邻正文和思考各自保留，不聚合文本且不裁剪内容", () => {
    expect(
      shape(buildRunBlocks([text(" 第一段 "), text("第二段"), thinking(" 想一想 "), thinking("再想", true, "t2")])),
    ).toEqual(["text: 第一段 ", "text:第二段", "thinking: 想一想 ", "thinking:再想"]);
  });

  it("空白正文、完成的空白思考和空调用数组被过滤，不打断同名工具聚合", () => {
    const empty = [text(""), text(" \n\t"), thinking(""), thinking(" \n\t"), tools([])];
    expect(buildRunBlocks(empty)).toEqual([]);
    expect(shape(buildRunBlocks([tools([call("r1")]), ...empty, tools([call("r2")])]))).toEqual(["tools:r1,r2"]);
    expect(buildRunBlocks([])).toEqual([]);
  });

  it.each(["", " \n\t"])("尚未完成的空白思考保留：%j", (content) => {
    expect(buildRunBlocks([thinking(content, false)])).toEqual([
      { kind: "thinking", key: "t", text: content, done: false },
    ]);
  });

  it("正文与思考 key 基于 segment.id，不随内容或完成状态改变", () => {
    const initial = buildRunBlocks([text("初稿", "text-id"), thinking("", false, "thinking-id")]);
    const updated = buildRunBlocks([text("正文完成", "text-id"), thinking("思考完成", true, "thinking-id")]);
    expect(initial.map((b) => b.key)).toEqual(["text-id", "thinking-id"]);
    expect(updated.map((b) => b.key)).toEqual(initial.map((b) => b.key));
  });

  it("工具 key 由首条调用 ID 派生，追加调用、更新状态或更换 segment ID 均不改变", () => {
    const first = call("r1", "Read", "running");
    const initial = buildRunBlocks([tools([first], "old-segment")]);
    const updated = buildRunBlocks([
      tools([{ ...first, status: "done", output: "完成" }, call("r2", "read", "error")], "new-segment"),
      tools([call("r3", "READ", "running")], "appended-segment"),
    ]);
    expect(initial[0].key).toBe("tools:r1");
    expect(updated.map((b) => b.key)).toEqual([initial[0].key]);
    expect(shape(initial)).toEqual(["tools:r1"]);
    expect(shape(updated)).toEqual(["tools:r1,r2,r3"]);
  });

  it("混合 done/error/running 的同名调用保留各自完整信息与顺序", () => {
    const calls = [
      { ...call("e1", "edit", "done"), patch: "first patch" },
      { ...call("e2", "Edit", "error"), output: "permission denied", patch: "failed patch" },
      { ...call("e3", "EDIT", "running"), output: "partial output" },
    ];
    const blocks = buildRunBlocks([tools(calls)]);
    expect(blocks).toEqual([{ kind: "tools", key: "tools:e1", calls }]);
    if (blocks[0].kind !== "tools") throw new Error("expected tools block");
    for (const [index, original] of calls.entries()) expect(blocks[0].calls[index]).toBe(original);
  });

  it("不修改 segments、calls、工具对象及参数；输出调用数组独立于输入和其他构建结果", () => {
    const segments = freezeDeep([
      thinking(),
      tools([call("r1", "Read")], "g1"),
      tools([call("r2", "read")], "g2"),
      text("完成"),
    ]);
    const snapshot = structuredClone(segments);
    const blocks = buildRunBlocks(segments);
    const again = buildRunBlocks(segments);
    expect(segments).toEqual(snapshot);
    expect(blocks).toEqual(again);
    const block = blocks[1];
    const other = again[1];
    const source = segments[1];
    if (block.kind !== "tools" || other.kind !== "tools" || source.kind !== "tools") {
      throw new Error("expected tools blocks and segment");
    }
    expect(block.calls).not.toBe(source.calls);
    expect(block.calls).not.toBe(other.calls);
    expect(block.calls[0]).toBe(source.calls[0]);
    block.calls.push(call("r3"));
    expect(other.calls).toHaveLength(2);
    expect(segments).toEqual(snapshot);
  });
});

describe("splitCompletedRun", () => {
  it("仅分离末尾正文作为总结，其余三类块原序进入过程区且不修改输入", () => {
    const blocks = freezeDeep(
      buildRunBlocks([thinking(), tools(), text("我先看下"), tools([call("e1", "edit")]), text("总结")]),
    );
    const { process, summary } = splitCompletedRun(blocks);
    expect(summary).toBe(blocks[4]);
    expect(summary?.text).toBe("总结");
    expect(shape(process)).toEqual(["thinking:想一下", "tools:c-read", "text:我先看下", "tools:e1"]);
    expect(process).toEqual(blocks.slice(0, -1));
    expect(blocks).toHaveLength(5);
  });

  it.each([tools(), thinking()])("非正文收尾不回溯总结：%j", (last) => {
    const blocks = buildRunBlocks([text("开始"), last]);
    const { process, summary } = splitCompletedRun(blocks);
    expect(summary).toBeUndefined();
    expect(process).toBe(blocks);
    expect(process).toHaveLength(2);
  });

  it("纯文本：只留最后一段，之前的阶段正文进过程区", () => {
    const { process, summary } = splitCompletedRun(buildRunBlocks([text("阶段"), text("总结")]));
    expect(summary?.text).toBe("总结");
    expect(shape(process)).toEqual(["text:阶段"]);
  });

  it("只有一段正文：没有过程区，直接展示总结", () => {
    const { process, summary } = splitCompletedRun(buildRunBlocks([text("总结")]));
    expect(process).toHaveLength(0);
    expect(summary?.text).toBe("总结");
  });

  it("空时间线没有总结或过程", () => {
    expect(splitCompletedRun([])).toEqual({ process: [] });
  });
});

describe("currentRunProgress", () => {
  it("运行中的工具 → 当前步骤（多个调用取最后一个运行中）", () => {
    const latest = call("c3", "bash", "running");
    const segment = freezeDeep(tools([call("c1"), call("c2", "read", "running"), latest, call("c4", "edit", "error")]));
    const progress = currentRunProgress(segment);
    expect(progress.kind).toBe("tool");
    expect(progress.kind === "tool" && progress.call).toBe(latest);
  });

  it("工具全部完成、失败或空调用 → 等待下一动作", () => {
    expect(currentRunProgress(tools()).kind).toBe("idle");
    expect(currentRunProgress(tools([call("c1", "read", "error")])).kind).toBe("idle");
    expect(currentRunProgress(tools([])).kind).toBe("idle");
  });

  it("思考流式中 → thinking；思考完成 → 等待下一动作", () => {
    expect(currentRunProgress(thinking("想", false)).kind).toBe("thinking");
    expect(currentRunProgress(thinking("", false)).kind).toBe("thinking");
    expect(currentRunProgress(thinking()).kind).toBe("idle");
  });

  it("正文流式中 → output，包括空白正文", () => {
    expect(currentRunProgress(text("输出中")).kind).toBe("output");
    expect(currentRunProgress(text("")).kind).toBe("output");
  });

  it("没有流式尾段（回合间隙/空占位）→ 等待下一动作", () => {
    expect(currentRunProgress(undefined).kind).toBe("idle");
  });
});
