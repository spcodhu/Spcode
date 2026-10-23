/**
 * 运行状态条（RunStatusBar）状态推导单测：
 * deriveRunStatus 是纯函数，覆盖各分支与优先级。
 */
import type { PermissionRequest, QuestionRequest } from "@spcode/shared";
import { describe, expect, it } from "vitest";
import { deriveRunStatus, formatElapsed, shouldShowRunStatusBar } from "../src/renderer/src/run-status.js";
import type { ChatMessage, SessionState } from "../src/renderer/src/store.js";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    meta: {
      id: "s1",
      mode: "chat",
      cwd: "",
      title: "t",
      model: null,
      thinkingLevel: "off",
      createdAt: 0,
      updatedAt: 0,
    },
    messages: [],
    running: true,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costInput: 0,
      costOutput: 0,
      costCacheRead: 0,
      costCacheWrite: 0,
      costTotal: 0,
      count: 0,
    },
    lastUsage: null,
    supportedThinkingLevels: [],
    todos: [],
    planMode: false,
    ...overrides,
  };
}

function assistantMsg(segments: ChatMessage["segments"], streaming = true): ChatMessage {
  return { id: "m1", role: "assistant", segments, streaming };
}

const perm = (sessionId: string, toolName = "bash"): PermissionRequest => ({
  requestId: "p1",
  sessionId,
  toolName,
  args: {},
  risk: "write",
});

const question = (sessionId: string): QuestionRequest => ({
  requestId: "q1",
  sessionId,
  questions: [{ question: "?" }],
});

describe("deriveRunStatus", () => {
  it("会话未运行 → null（状态条隐藏）", () => {
    expect(deriveRunStatus(makeSession({ running: false }), [], [], "s1")).toBeNull();
    expect(deriveRunStatus(undefined, [], [], "s1")).toBeNull();
  });

  it("无消息/空段 → 正在工作…", () => {
    expect(deriveRunStatus(makeSession(), [], [], "s1")?.kind).toBe("working");
    const s = makeSession({ messages: [assistantMsg([])] });
    expect(deriveRunStatus(s, [], [], "s1")?.kind).toBe("working");
  });

  it("思考流入中 → 思考中…", () => {
    const s = makeSession({
      messages: [assistantMsg([{ kind: "thinking", id: "1", text: "嗯", done: false }])],
    });
    expect(deriveRunStatus(s, [], [], "s1")?.kind).toBe("thinking");
  });

  it("思考已完成且是末段（下一动作未到）→ 正在工作…", () => {
    const s = makeSession({
      messages: [assistantMsg([{ kind: "thinking", id: "1", text: "嗯", done: true }])],
    });
    expect(deriveRunStatus(s, [], [], "s1")?.kind).toBe("working");
  });

  it("工具执行中 → 正在{工具} · 参数摘要", () => {
    const s = makeSession({
      messages: [
        assistantMsg([
          {
            kind: "tools",
            id: "1",
            calls: [
              { id: "c1", name: "read", args: { path: "/a.ts" }, status: "done", output: "" },
              { id: "c2", name: "edit", args: { path: "/b.ts" }, status: "running", output: "" },
            ],
          },
        ]),
      ],
    });
    const st = deriveRunStatus(s, [], [], "s1");
    expect(st?.kind).toBe("tool");
    expect(st?.label).toBe("正在编辑文件");
    expect(st?.detail).toBe("/b.ts");
  });

  it("终端命令执行中 → 正在运行终端命令（与步骤行文案一致）", () => {
    const s = makeSession({
      messages: [
        assistantMsg([
          {
            kind: "tools",
            id: "1",
            calls: [{ id: "c1", name: "bash", args: { command: "ls" }, status: "running", output: "" }],
          },
        ]),
      ],
    });
    const st = deriveRunStatus(s, [], [], "s1");
    expect(st?.label).toBe("正在运行终端命令");
    expect(st?.detail).toBe("ls");
  });

  it("工具全部完成（等待下一回合）→ 正在工作…", () => {
    const s = makeSession({
      messages: [
        assistantMsg([
          { kind: "tools", id: "1", calls: [{ id: "c1", name: "bash", args: {}, status: "done", output: "" }] },
        ]),
      ],
    });
    expect(deriveRunStatus(s, [], [], "s1")?.kind).toBe("working");
  });

  it("正文流入中 → 正在输出…", () => {
    const s = makeSession({ messages: [assistantMsg([{ kind: "text", id: "1", text: "你好" }])] });
    expect(deriveRunStatus(s, [], [], "s1")?.kind).toBe("text");
  });

  it("末条消息已定格但会话仍在跑（回合间隙）→ 正在工作…", () => {
    const s = makeSession({
      messages: [{ id: "m0", role: "user", segments: [{ kind: "text", id: "x", text: "hi" }], streaming: false }],
    });
    expect(deriveRunStatus(s, [], [], "s1")?.kind).toBe("working");
  });

  it("等待权限优先于运行阶段", () => {
    const s = makeSession({
      messages: [assistantMsg([{ kind: "thinking", id: "1", text: "x", done: false }])],
    });
    const st = deriveRunStatus(s, [perm("s1")], [], "s1");
    expect(st?.kind).toBe("permission");
    expect(st?.label).toContain("命令"); // bash → 命令
  });

  it("等待提问优先级最高；他会话的待办不影响", () => {
    const s = makeSession();
    expect(deriveRunStatus(s, [perm("other")], [question("s1")], "s1")?.kind).toBe("question");
    expect(deriveRunStatus(s, [perm("other")], [question("other")], "s1")?.kind).toBe("working");
  });
});

describe("formatElapsed", () => {
  it("秒级与分:秒格式", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59)).toBe("59s");
    expect(formatElapsed(60)).toBe("1:00");
    expect(formatElapsed(65)).toBe("1:05");
    expect(formatElapsed(600)).toBe("10:00");
  });
});

describe("压缩状态", () => {
  it("compacting 时显示「正在压缩上下文…」，即使 running 已结束（手动压缩先 abort）", () => {
    const session = makeSession({ running: false, compacting: true });
    const status = deriveRunStatus(session, [], [], "s1");
    expect(status?.label).toBe("正在压缩上下文…");
  });

  it("compacting 优先于运行中状态（自动压缩发生在回合结束后、settled 前）", () => {
    const session = makeSession({ running: true, compacting: true });
    const status = deriveRunStatus(session, [], [], "s1");
    expect(status?.label).toBe("正在压缩上下文…");
  });
});

describe("shouldShowRunStatusBar", () => {
  it("思考/工具/输出/回合间隙由消息流表达，底部状态条不重复", () => {
    for (const kind of ["thinking", "tool", "text", "working"] as const) {
      expect(shouldShowRunStatusBar(makeSession(), { kind, label: "x" })).toBe(false);
    }
  });

  it("压缩/等待权限/等待回答/重试仍显示底部状态条", () => {
    expect(
      shouldShowRunStatusBar(makeSession({ compacting: true }), { kind: "working", label: "正在压缩上下文…" }),
    ).toBe(true);
    for (const kind of ["permission", "question", "retry"] as const) {
      expect(shouldShowRunStatusBar(makeSession(), { kind, label: "x" })).toBe(true);
    }
  });

  it("没有运行状态时不显示", () => {
    expect(shouldShowRunStatusBar(makeSession(), null)).toBe(false);
  });
});
