/**
 * SessionOutputLog 单测：环形缓冲上限、since 过滤与升序、drop/clear。
 */
import { describe, expect, it } from "vitest";
import { SessionOutputLog } from "../src/main/remote/output-log.js";

describe("SessionOutputLog", () => {
  it("since 只返回 seq > afterSeq 的 chunk，按 seq 升序", () => {
    const log = new SessionOutputLog();
    log.append("s1", { seq: 0, kind: "text", chunk: "a" });
    log.append("s1", { seq: 1, kind: "thinking", chunk: "b" });
    log.append("s1", { seq: 2, kind: "text", chunk: "c" });
    expect(log.since("s1", 0).map((c) => c.seq)).toEqual([1, 2]);
    expect(log.since("s1", -1)).toHaveLength(3);
    expect(log.since("s1", 2)).toEqual([]);
    expect(log.since("nope", -1)).toEqual([]);
  });

  it("环形缓冲：超过上限丢最旧", () => {
    const log = new SessionOutputLog(3);
    for (let i = 0; i < 5; i++) log.append("s1", { seq: i, kind: "text", chunk: `c${i}` });
    expect(log.since("s1", -1).map((c) => c.seq)).toEqual([2, 3, 4]);
  });

  it("缓冲按会话隔离；drop 只清目标会话", () => {
    const log = new SessionOutputLog();
    log.append("s1", { seq: 0, kind: "text", chunk: "a" });
    log.append("s2", { seq: 0, kind: "text", chunk: "b" });
    log.drop("s1");
    expect(log.since("s1", -1)).toEqual([]);
    expect(log.since("s2", -1)).toHaveLength(1);
    log.clear();
    expect(log.since("s2", -1)).toEqual([]);
  });
});
