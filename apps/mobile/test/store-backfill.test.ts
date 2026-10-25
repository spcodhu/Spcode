/**
 * 断线补拉合并逻辑单测（store）：
 * - 实时 chunk 的缺口标记；
 * - backfill 补齐缺口后标记消除、顺序正确、同 kind 合并；
 * - 桌面缓冲截断（只留最近 500 个 chunk）时保留缺口标记；
 * - 实时 / backfill 竞争去重。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getOutputMaxSeq, useAppStore } from "../src/state/store";

const S = "sess-1";

function texts(sessionId = S): string {
  return (useAppStore.getState().outputs[sessionId] ?? []).map((c) => (c.gap ? "‖GAP‖" : c.chunk)).join("");
}

beforeEach(() => {
  useAppStore.getState().reset();
});

describe("appendOutput / mergeBackfill", () => {
  it("连续 seq 无缺口标记，同 kind 合并", () => {
    const s = useAppStore.getState();
    s.appendOutput(S, "A", "text", 0);
    s.appendOutput(S, "B", "text", 1);
    expect(texts()).toBe("AB");
    expect(getOutputMaxSeq(S)).toBe(1);
  });

  it("seq 跳号插缺口标记；backfill 补齐后标记消除", () => {
    const s = useAppStore.getState();
    s.appendOutput(S, "A", "text", 0);
    s.appendOutput(S, "D", "text", 3); // 1,2 缺失 → 缺口
    expect(texts()).toBe("A‖GAP‖D");

    s.mergeBackfill(S, [
      { seq: 1, kind: "text", chunk: "B" },
      { seq: 2, kind: "text", chunk: "C" },
    ]);
    expect(texts()).toBe("ABCD");
    expect(useAppStore.getState().outputs[S]!.some((c) => c.gap)).toBe(false);
  });

  it("backfill 补不齐（桌面截断）时保留缺口标记", () => {
    const s = useAppStore.getState();
    s.appendOutput(S, "A", "text", 0);
    s.appendOutput(S, "Z", "text", 10);
    s.mergeBackfill(S, [
      { seq: 8, kind: "text", chunk: "Y" },
      { seq: 9, kind: "text", chunk: "" },
    ]); // 桌面只剩 8..10；1..7 补不齐 → 保留缺口
    expect(texts()).toBe("A‖GAP‖YZ");
  });

  it("全新会话 backfill 从非 0 seq 开始 → 头部截断缺口", () => {
    useAppStore.getState().mergeBackfill(S, [
      { seq: 3, kind: "text", chunk: "X" },
      { seq: 4, kind: "thinking", chunk: "Y" },
    ]);
    expect(texts()).toBe("‖GAP‖XY");
  });

  it("实时/backfill 竞争：重复 seq 去重", () => {
    const s = useAppStore.getState();
    s.appendOutput(S, "A", "text", 0);
    s.mergeBackfill(S, [
      { seq: 0, kind: "text", chunk: "A" },
      { seq: 1, kind: "text", chunk: "B" },
    ]);
    s.appendOutput(S, "B", "text", 1); // 迟到的实时重复帧
    expect(texts()).toBe("AB");
    expect(getOutputMaxSeq(S)).toBe(1);
  });

  it("removeSession 清理输出与 seq 追踪", () => {
    const s = useAppStore.getState();
    s.setSessions([
      {
        id: S,
        title: "t",
        mode: "chat",
        createdAt: 0,
        updatedAt: 0,
      } as never,
    ]);
    s.appendOutput(S, "A", "text", 0);
    s.removeSession(S);
    expect(useAppStore.getState().outputs[S]).toBeUndefined();
    expect(getOutputMaxSeq(S)).toBeUndefined();
    expect(useAppStore.getState().sessions[S]).toBeUndefined();
  });
});

describe("按 session/request 保存的草稿", () => {
  it("输入草稿按 sessionId 隔离，失败恢复只接受未继续编辑的等待版本", () => {
    const s = useAppStore.getState();
    s.setInputDraft(S, "发送前快照");
    s.setInputDraft("other", "另一会话");
    const waitingVersion = s.setInputDraft(S, "");
    s.setInputDraft(S, "等待期间的新文本");

    expect(s.restoreInputDraft(S, "发送前快照", waitingVersion)).toBe(false);
    expect(useAppStore.getState().inputDrafts[S]?.text).toBe("等待期间的新文本");
    expect(useAppStore.getState().inputDrafts.other?.text).toBe("另一会话");

    const secondWaitingVersion = s.setInputDraft(S, "");
    const before = useAppStore.getState().inputDrafts[S]!;
    expect(s.restoreInputDraft(S, "第二次快照", secondWaitingVersion)).toBe(true);
    const restored = useAppStore.getState().inputDrafts[S]!;
    expect(restored.text).toBe("第二次快照");
    expect(restored.version).toBeGreaterThan(before.version);
    expect(restored.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it("reset 不复用草稿版本，旧请求不能覆盖 reset 后的新会话输入", () => {
    const s = useAppStore.getState();
    s.setInputDraft(S, "旧快照");
    const oldWaitingVersion = s.setInputDraft(S, "");
    s.reset();
    s.setInputDraft(S, "reset 后新文本");
    const newWaitingVersion = s.setInputDraft(S, "");
    expect(newWaitingVersion).not.toBe(oldWaitingVersion);
    expect(s.restoreInputDraft(S, "旧快照", oldWaitingVersion)).toBe(false);
    expect(useAppStore.getState().inputDrafts[S]?.text).toBe("");
    expect(s.restoreInputDraft(S, "reset 后快照", newWaitingVersion)).toBe(true);
    expect(useAppStore.getState().inputDrafts[S]?.text).toBe("reset 后快照");
  });

  it("提问草稿按 requestId 保留到真正 resolved，删除会话会退出详情并清理相关状态", () => {
    const s = useAppStore.getState();
    s.setSessions([sessionMeta(S), sessionMeta("other")]);
    s.pushQuestion({ requestId: "q1", sessionId: S, questions: [] });
    s.setQuestionDraft("q1", { answers: { "0": ["a"] }, freeText: { "1": "文本" } });
    s.setInputDraft(S, "草稿");
    s.appendOutput(S, "out", "text", 0);
    s.setRoute({ name: "session", id: S });

    // 权限卡临时置顶不需要 dropQuestion；草稿因而可在重新展示时恢复。
    expect(useAppStore.getState().questionDrafts.q1?.answers["0"]).toEqual(["a"]);
    s.setSessions([sessionMeta("other")]);
    const next = useAppStore.getState();
    expect(next.route).toEqual({ name: "sessions" });
    expect(next.inputDrafts[S]).toBeUndefined();
    expect(next.outputs[S]).toBeUndefined();
    expect(next.questions).toEqual([]);
    expect(next.questionDrafts.q1).toBeUndefined();
  });
});

function sessionMeta(id: string) {
  return {
    id,
    title: id,
    mode: "chat",
    cwd: "",
    model: null,
    thinkingLevel: "medium",
    sessionFile: null,
    createdAt: 0,
    updatedAt: 0,
  } as const;
}
