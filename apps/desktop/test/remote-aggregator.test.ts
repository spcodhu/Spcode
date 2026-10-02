/**
 * 事件聚合器单测：400ms 窗口聚合、每会话单调 seq、非文本事件直接映射、
 * text/thinking 切换与结构化事件到达时先冲刷保证时序。
 * 用 40ms 小窗口 + 真实定时器。
 */
import type { HostEvent, RemoteEvent } from "@spcode/shared";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteEventAggregator } from "../src/main/remote/aggregator.js";

const WINDOW_MS = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function textDelta(delta: string): HostEvent {
  return { type: "session.event", sessionId: "s1", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } } };
}

function setup(windowMs = WINDOW_MS) {
  const events: RemoteEvent[] = [];
  const agg = new RemoteEventAggregator({ windowMs, emit: (e) => events.push(e) });
  return { agg, events };
}

describe("RemoteEventAggregator", () => {
  let agg: RemoteEventAggregator | null = null;
  afterEach(() => {
    agg?.dispose();
    agg = null;
  });

  it("窗口内的 text_delta 聚合成一个 chunk；窗口结束后下一批 seq 递增", async () => {
    const s = setup();
    agg = s.agg;
    s.agg.handle(textDelta("你"));
    s.agg.handle(textDelta("好"));
    s.agg.handle(textDelta("，世界"));
    await sleep(WINDOW_MS * 2);
    expect(s.events).toEqual([{ type: "session.output", sessionId: "s1", chunk: "你好，世界", kind: "text", seq: 0 }]);

    s.agg.handle(textDelta("第二段"));
    await sleep(WINDOW_MS * 2);
    expect(s.events).toHaveLength(2);
    expect(s.events[1]).toMatchObject({ chunk: "第二段", seq: 1 });
  });

  it("seq 每会话独立计数", async () => {
    const s = setup();
    agg = s.agg;
    s.agg.handle(textDelta("a"));
    s.agg.handle({ type: "session.event", sessionId: "s2", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "b" } } });
    await sleep(WINDOW_MS * 2);
    const outputs = s.events.filter((e) => e.type === "session.output");
    expect(outputs).toHaveLength(2);
    expect(outputs.find((e) => e.sessionId === "s1")).toMatchObject({ seq: 0 });
    expect(outputs.find((e) => e.sessionId === "s2")).toMatchObject({ seq: 0 });
  });

  it("text / thinking 切换时立即冲刷，不混在同一 chunk", async () => {
    const s = setup();
    agg = s.agg;
    s.agg.handle(textDelta("正文"));
    s.agg.handle({ type: "session.event", sessionId: "s1", event: { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "思考" } } });
    // thinking 到达应立即冲刷 text
    expect(s.events).toEqual([{ type: "session.output", sessionId: "s1", chunk: "正文", kind: "text", seq: 0 }]);
    await sleep(WINDOW_MS * 2);
    expect(s.events[1]).toMatchObject({ chunk: "思考", kind: "thinking", seq: 1 });
  });

  it("agent_start / agent_settled 映射为 session.status，并先冲刷挂起文本", async () => {
    const s = setup();
    agg = s.agg;
    s.agg.handle({ type: "session.event", sessionId: "s1", event: { type: "agent_start" } });
    s.agg.handle(textDelta("部分输出"));
    s.agg.handle({ type: "session.event", sessionId: "s1", event: { type: "agent_settled" } });
    expect(s.events).toEqual([
      { type: "session.status", sessionId: "s1", status: "running" },
      { type: "session.output", sessionId: "s1", chunk: "部分输出", kind: "text", seq: 0 },
      { type: "session.status", sessionId: "s1", status: "idle" },
    ]);
  });

  it("todo 等结构化事件直接映射，且时序排在挂起文本之后", async () => {
    const s = setup();
    agg = s.agg;
    s.agg.handle(textDelta("先做"));
    s.agg.handle({ type: "session.todo", sessionId: "s1", todos: [{ content: "任务A", status: "pending" }] });
    expect(s.events).toEqual([
      { type: "session.output", sessionId: "s1", chunk: "先做", kind: "text", seq: 0 },
      { type: "session.todo", sessionId: "s1", todos: [{ content: "任务A", status: "pending" }] },
    ]);
  });

  it("permission.request 原样透传（含 risk）并附带 waiting_permission 状态", () => {
    const s = setup();
    agg = s.agg;
    const request = { requestId: "r1", sessionId: "s1", toolName: "Bash", args: { cmd: "rm -rf /" }, risk: "danger" as const };
    s.agg.handle({ type: "permission.request", request });
    expect(s.events).toEqual([
      { type: "permission.request", request },
      { type: "session.status", sessionId: "s1", status: "waiting_permission" },
    ]);
  });

  it("question.request / renamed / planmode / usage / schedule.fired / sessions.changed 透传", () => {
    const s = setup();
    agg = s.agg;
    const q = { requestId: "q1", sessionId: "s1", questions: [{ question: "继续吗？" }] };
    s.agg.handle({ type: "question.request", request: q });
    s.agg.handle({ type: "session.renamed", sessionId: "s1", title: "新标题" });
    s.agg.handle({ type: "session.planmode", sessionId: "s1", enabled: true });
    s.agg.handle({ type: "schedule.fired", taskId: "t1", name: "晨报", sessionId: "s2" });
    s.agg.handle({ type: "sessions.changed" });
    expect(s.events).toEqual([
      { type: "question.request", request: q },
      { type: "session.renamed", sessionId: "s1", title: "新标题" },
      { type: "session.planmode", sessionId: "s1", enabled: true },
      { type: "schedule.fired", taskId: "t1", name: "晨报", sessionId: "s2" },
      { type: "sessions.changed" },
    ]);
  });

  it("history / plan / ready / response / host.error 不透传", () => {
    const s = setup();
    agg = s.agg;
    s.agg.handle({ type: "session.history", sessionId: "s1", messages: [] });
    s.agg.handle({ type: "session.plan", sessionId: "s1", path: "/x" });
    s.agg.handle({ type: "ready" });
    s.agg.handle({ type: "response", id: "1", success: true });
    s.agg.handle({ type: "host.error", message: "boom" });
    expect(s.events).toEqual([]);
  });

  it("dispose 后挂起缓冲不再 emit", async () => {
    const s = setup();
    agg = s.agg;
    s.agg.handle(textDelta("没来得及"));
    s.agg.dispose();
    await sleep(WINDOW_MS * 2);
    expect(s.events).toEqual([]);
  });
});
