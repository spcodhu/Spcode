import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChatMessage,
  flattenSegments,
  groupMessagesForRender,
  messageText,
  type Segment,
  teardownHostEvents,
  useStore,
} from "../src/renderer/src/store.js";

/**
 * 回归测试：StrictMode 下 App 挂载 effect 跑两次 → init() 重入。
 * 宿主事件订阅必须幂等，否则每个 HostEvent 被应用两遍
 * （历史上表现为 assistant 回复气泡重复出现两次、用量翻倍）。
 */

function stubSpcodeApi() {
  const listeners: Array<(event: unknown) => void> = [];
  const onEvent = vi.fn((cb: (event: unknown) => void) => {
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  });
  vi.stubGlobal("window", {
    spcode: {
      onEvent,
      onUpdateState: vi.fn(() => () => {}),
      updateGetState: vi.fn(async () => ({ status: "idle" })),
      getSettings: vi.fn(async () => ({})),
      listSessions: vi.fn(async () => []),
      getComposerDrafts: vi.fn(async () => ({})),
      setComposerDrafts: vi.fn(async () => {}),
      command: vi.fn(async () => []),
    },
  });
  return { onEvent, listeners };
}

/** 往 store 里塞一个空会话并激活（绕过 session.create IPC） */
function seedSession(sessionId: string) {
  useStore.setState((s) => ({
    activeSessionId: sessionId,
    sessions: {
      ...s.sessions,
      [sessionId]: {
        meta: {
          id: sessionId,
          mode: "chat" as const,
          cwd: "",
          title: "t",
          model: null,
          thinkingLevel: "off",
          createdAt: 0,
          updatedAt: 0,
        },
        messages: [],
        running: false,
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
        supportedThinkingLevels: [],
        todos: [],
      },
    },
  }));
}

afterEach(() => {
  teardownHostEvents();
  vi.unstubAllGlobals();
});

describe("store.init 宿主事件订阅", () => {
  it("重复/并发 init 只订阅一次", async () => {
    const { onEvent, listeners } = stubSpcodeApi();
    // 模拟 StrictMode：两次 init 交错执行（都在 await 点上让出）
    await Promise.all([useStore.getState().init(), useStore.getState().init()]);
    await useStore.getState().init();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(listeners).toHaveLength(1);
  });

  it("teardown 后可以重新订阅", async () => {
    const { onEvent, listeners } = stubSpcodeApi();
    await useStore.getState().init();
    teardownHostEvents();
    expect(listeners).toHaveLength(0);
    await useStore.getState().init();
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(listeners).toHaveLength(1);
  });

  it("事件只被应用一次（message_end 不产生重复气泡）", async () => {
    const { listeners } = stubSpcodeApi();
    await Promise.all([useStore.getState().init(), useStore.getState().init()]);

    const sessionId = "s1";
    useStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          meta: {
            id: sessionId,
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
          supportedThinkingLevels: [],
          todos: [],
        },
      },
    }));

    const messageEnd = {
      type: "session.event",
      sessionId,
      event: {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "你好！有什么我可以帮你的？" }] },
      },
    };
    // 宿主每发一次事件，所有存活监听器各触发一次（修复后只剩一个）
    for (const cb of listeners) cb(messageEnd);

    const messages = useStore.getState().sessions[sessionId]?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messageText(messages[0]!)).toBe("你好！有什么我可以帮你的？");
    expect(messages[0]?.streaming).toBe(false);
  });
});

describe("sendPrompt 流式占位与收尾", () => {
  it("发送后立即创建 assistant 流式占位消息（加载动画不等首个 delta）", async () => {
    stubSpcodeApi();
    seedSession("s-prompt");
    await useStore.getState().sendPrompt("你好");

    const session = useStore.getState().sessions["s-prompt"];
    expect(session?.messages).toHaveLength(2);
    expect(session?.messages[0]?.role).toBe("user");
    expect(session?.messages[1]?.role).toBe("assistant");
    expect(session?.messages[1]?.streaming).toBe(true);
    expect(session?.running).toBe(true);
  });

  it("首个 text_delta 写入既有占位而不是新建消息", async () => {
    stubSpcodeApi();
    seedSession("s-delta");
    await useStore.getState().sendPrompt("你好");
    useStore.getState().applyHostEvent({
      type: "session.event",
      sessionId: "s-delta",
      event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你" } },
    } as never);

    const messages = useStore.getState().sessions["s-delta"]?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(messageText(messages[1]!)).toBe("你");
  });

  it("agent_settled：空占位直接丢弃，有内容的定格", async () => {
    stubSpcodeApi();
    // 空占位（用户发送后立刻 abort，没等到任何 delta）
    seedSession("s-empty");
    await useStore.getState().sendPrompt("你好");
    useStore.getState().applyHostEvent({
      type: "session.event",
      sessionId: "s-empty",
      event: { type: "agent_settled" },
    } as never);
    expect(useStore.getState().sessions["s-empty"]?.messages).toHaveLength(1);
    expect(useStore.getState().sessions["s-empty"]?.running).toBe(false);

    // 有内容的流式消息在 settle 后定格
    seedSession("s-full");
    await useStore.getState().sendPrompt("你好");
    useStore.getState().applyHostEvent({
      type: "session.event",
      sessionId: "s-full",
      event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "部分回复" } },
    } as never);
    useStore.getState().applyHostEvent({
      type: "session.event",
      sessionId: "s-full",
      event: { type: "agent_settled" },
    } as never);
    const messages = useStore.getState().sessions["s-full"]?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(messages[1]?.streaming).toBe(false);
    expect(messageText(messages[1]!)).toBe("部分回复");
  });

  it("段严格按到达顺序追加：工具之后到达的思考不会插到工具前面（无插叙回归）", async () => {
    stubSpcodeApi();
    seedSession("s-order");
    await useStore.getState().sendPrompt("查一下");
    const evt = (event: Record<string, unknown>) =>
      useStore.getState().applyHostEvent({ type: "session.event", sessionId: "s-order", event } as never);

    // 第一回合：思考 → message_end 定格
    evt({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "先搜索" } });
    evt({ type: "message_end", message: { role: "assistant", content: [] } });
    // 工具执行（message_end 之后到达，进入新流式消息）
    evt({ type: "tool_execution_start", toolCallId: "t1", toolName: "WebSearch", args: { query: "a" } });
    evt({ type: "tool_execution_start", toolCallId: "t2", toolName: "WebSearch", args: { query: "b" } });
    // 第二回合思考随后到达
    evt({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "结果不好，换词" } });

    const session = useStore.getState().sessions["s-order"];
    // 渲染层只把 assistant 运行消息交给 flattenSegments（用户气泡走另一路）
    const assistantMsgs = (session?.messages ?? []).filter((m) => m.role === "assistant");
    const flat = flattenSegments(assistantMsgs);
    // 时间线：思考 → 工具批 → 思考；工具批内的两次调用保持顺序
    expect(flat.map((s) => s.kind)).toEqual(["thinking", "tools", "thinking"]);
    const tools = flat[1];
    expect(tools?.kind === "tools" && tools.calls.map((c) => c.id)).toEqual(["t1", "t2"]);
    const thinking2 = flat[2];
    expect(thinking2?.kind === "thinking" && thinking2.text).toBe("结果不好，换词");
  });
});

describe("flattenSegments 时间线拍平", () => {
  const seg = {
    thinking: (id: string, text: string): Segment => ({ kind: "thinking", id, text, done: true }),
    text: (id: string, text: string): Segment => ({ kind: "text", id, text }),
    tools: (id: string, ...ids: string[]): Segment => ({
      kind: "tools",
      id,
      calls: ids.map((i) => ({ id: i, name: "websearch", args: {}, status: "done" as const, output: "" })),
    }),
  };
  const msg = (id: string, segments: Segment[]): ChatMessage => ({
    id,
    role: "assistant",
    segments,
    streaming: false,
  });

  it("跨消息相邻同类段合并，顺序不变", () => {
    const flat = flattenSegments([
      msg("a1", [seg.thinking("t1", "第一轮"), seg.tools("w1", "c1")]),
      msg("a2", [seg.tools("w2", "c2"), seg.thinking("t2", "第二轮")]),
      msg("a3", [seg.thinking("t3", "第三轮"), seg.text("x1", "总结")]),
    ]);
    expect(flat.map((s) => s.kind)).toEqual(["thinking", "tools", "thinking", "text"]);
    const thinking = flat[2];
    expect(thinking?.kind === "thinking" && thinking.text).toBe("第二轮\n\n第三轮");
    const tools = flat[1];
    expect(tools?.kind === "tools" && tools.calls.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("拍平不改动原消息里的段对象（引用隔离）", () => {
    const original = seg.tools("w1", "c1");
    const messages = [msg("a1", [original]), msg("a2", [seg.tools("w2", "c2")])];
    flattenSegments(messages);
    expect(original.calls).toHaveLength(1);
  });

  it("空文本段被丢弃", () => {
    const flat = flattenSegments([msg("a1", [seg.text("x1", "  "), seg.text("x2", "有内容")])]);
    expect(flat).toHaveLength(1);
  });
});

describe("session.renamed 标题更新", () => {
  it("同时更新会话元信息与侧栏注册表条目", () => {
    stubSpcodeApi();
    seedSession("s-rename");
    useStore.setState((s) => ({
      registrySessions: [
        {
          id: "s-rename",
          mode: "chat" as const,
          cwd: "",
          title: "新聊天",
          model: null,
          thinkingLevel: "off",
          sessionFile: null,
          createdAt: 0,
          updatedAt: 0,
        },
        ...s.registrySessions,
      ],
    }));

    useStore.getState().applyHostEvent({
      type: "session.renamed",
      sessionId: "s-rename",
      title: "讨论外包薪资",
    });

    expect(useStore.getState().sessions["s-rename"]?.meta.title).toBe("讨论外包薪资");
    expect(useStore.getState().registrySessions.find((r) => r.id === "s-rename")?.title).toBe("讨论外包薪资");
  });

  it("会话未加载进内存时也更新注册表", () => {
    stubSpcodeApi();
    useStore.setState((s) => ({
      registrySessions: [
        {
          id: "s-not-loaded",
          mode: "chat" as const,
          cwd: "",
          title: "新聊天",
          model: null,
          thinkingLevel: "off",
          sessionFile: null,
          createdAt: 0,
          updatedAt: 0,
        },
        ...s.registrySessions,
      ],
    }));
    useStore.getState().applyHostEvent({
      type: "session.renamed",
      sessionId: "s-not-loaded",
      title: "未加载会话",
    });
    expect(useStore.getState().registrySessions.find((r) => r.id === "s-not-loaded")?.title).toBe("未加载会话");
  });
});

describe("session.usage 最近用量快照", () => {
  it("lastUsage 记录最近一次请求（上下文占用环的数据源）", () => {
    stubSpcodeApi();
    seedSession("s-usage");
    const usage = (input: number) => ({
      sessionId: "s-usage",
      model: { provider: "kimi-coding", modelId: "k3" },
      timestamp: Date.now(),
      input,
      output: 10,
      cacheRead: 100,
      cacheWrite: 0,
      costInput: 0,
      costOutput: 0,
      costCacheRead: 0,
      costCacheWrite: 0,
      costTotal: 0,
    });
    useStore.getState().applyHostEvent({ type: "session.usage", sessionId: "s-usage", usage: usage(1000) });
    useStore.getState().applyHostEvent({ type: "session.usage", sessionId: "s-usage", usage: usage(2000) });

    const session = useStore.getState().sessions["s-usage"];
    expect(session?.lastUsage?.input).toBe(2000); // 最近一次
    expect(session?.usage.input).toBe(3000); // 聚合照旧累加
  });
});

describe("groupMessagesForRender 运行归并", () => {
  const msg = (id: string, role: "user" | "assistant"): ChatMessage => ({
    id,
    role,
    segments: [],
    streaming: false,
  });

  it("连续 assistant 消息归并为一个运行，用户消息切开运行", () => {
    const items = groupMessagesForRender([
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("a2", "assistant"),
      msg("a3", "assistant"),
      msg("u2", "user"),
      msg("a4", "assistant"),
    ]);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ kind: "user", key: "u1" });
    expect(items[1]).toMatchObject({ kind: "run", key: "a1" });
    expect(items[1]?.kind === "run" && items[1].messages.map((m) => m.id)).toEqual(["a1", "a2", "a3"]);
    expect(items[2]).toMatchObject({ kind: "user", key: "u2" });
    expect(items[3]?.kind === "run" && items[3].messages.map((m) => m.id)).toEqual(["a4"]);
  });

  it("空列表与纯用户消息", () => {
    expect(groupMessagesForRender([])).toHaveLength(0);
    const items = groupMessagesForRender([msg("u1", "user"), msg("u2", "user")]);
    expect(items.every((i) => i.kind === "user")).toBe(true);
  });
});

describe("permission.resolved 双端撤卡", () => {
  it("任一端裁决后撤掉同 requestId 的批准卡；未知 requestId 不影响", () => {
    stubSpcodeApi();
    useStore.setState({ pendingPermissions: [] });
    const req = (id: string) => ({
      requestId: id,
      sessionId: "s1",
      toolName: "Bash",
      args: {},
      risk: "write" as const,
    });
    useStore.getState().applyHostEvent({ type: "permission.request", request: req("r1") });
    useStore.getState().applyHostEvent({ type: "permission.request", request: req("r2") });
    expect(useStore.getState().pendingPermissions.map((p) => p.requestId)).toEqual(["r1", "r2"]);

    // 远程端裁决了 r1（permission.resolved by="remote"）→ 桌面卡片撤掉
    useStore.getState().applyHostEvent({ type: "permission.resolved", requestId: "r1", approved: true, by: "remote" });
    expect(useStore.getState().pendingPermissions.map((p) => p.requestId)).toEqual(["r2"]);

    // 未知 requestId 不影响现有卡片
    useStore
      .getState()
      .applyHostEvent({ type: "permission.resolved", requestId: "ghost", approved: true, by: "local" });
    expect(useStore.getState().pendingPermissions).toHaveLength(1);
  });
});

describe("compaction 事件流", () => {
  it("compaction_start 置压缩中标志，compaction_end 清标志并插入分隔线消息", () => {
    stubSpcodeApi();
    seedSession("s-compact");
    const evt = (event: Record<string, unknown>) =>
      useStore.getState().applyHostEvent({ type: "session.event", sessionId: "s-compact", event } as never);

    evt({ type: "compaction_start", reason: "threshold" });
    expect(useStore.getState().sessions["s-compact"]?.compacting).toBe(true);

    evt({
      type: "compaction_end",
      reason: "threshold",
      result: { summary: "## Goal\n做点事", firstKeptEntryId: "e9", tokensBefore: 182000, estimatedTokensAfter: 52000 },
      aborted: false,
      willRetry: false,
    });
    const session = useStore.getState().sessions["s-compact"];
    expect(session?.compacting).toBe(false);
    const notice = session?.messages[session.messages.length - 1];
    expect(notice?.role).toBe("notice");
    expect(notice?.notice?.kind).toBe("compaction");
    expect(notice?.notice?.tokensBefore).toBe(182000);
    expect(notice?.notice?.tokensAfter).toBe(52000);
    expect(messageText(notice!)).toContain("182k");
    expect(messageText(notice!)).toContain("52k");
  });

  it("压缩失败（非取消）插入错误提示；用户取消不留痕", () => {
    stubSpcodeApi();
    seedSession("s-compact-fail");
    const evt = (event: Record<string, unknown>) =>
      useStore.getState().applyHostEvent({ type: "session.event", sessionId: "s-compact-fail", event } as never);

    // 手动压缩但内容太少：引擎 compaction_end 带 errorMessage
    evt({
      type: "compaction_end",
      reason: "manual",
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: "Compaction failed: Nothing to compact (session too small)",
    });
    let messages = useStore.getState().sessions["s-compact-fail"]?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("notice");
    expect(messageText(messages[0]!)).toContain("无需压缩");

    // 用户中途取消（aborted）：不再插入任何消息
    evt({ type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false });
    messages = useStore.getState().sessions["s-compact-fail"]?.messages ?? [];
    expect(messages).toHaveLength(1);
  });

  it("自动压缩的分隔线不影响 agent_settled 定格其前的流式 assistant 消息", () => {
    stubSpcodeApi();
    seedSession("s-compact-settle");
    // 模拟一轮进行中：streaming assistant 在流
    useStore.setState((s) => {
      const sess = s.sessions["s-compact-settle"];
      if (!sess) return s;
      return {
        sessions: {
          ...s.sessions,
          "s-compact-settle": {
            ...sess,
            running: true,
            messages: [
              {
                id: "u1",
                role: "user" as const,
                segments: [{ kind: "text" as const, id: "seg1", text: "问" }],
                streaming: false,
              },
              {
                id: "a1",
                role: "assistant" as const,
                segments: [{ kind: "thinking" as const, id: "seg2", text: "想", done: false }],
                streaming: true,
              },
            ],
          },
        },
      };
    });
    const evt = (event: Record<string, unknown>) =>
      useStore.getState().applyHostEvent({ type: "session.event", sessionId: "s-compact-settle", event } as never);

    // 回合结束后、agent_settled 前发生自动压缩：notice 插在流式消息之后
    evt({
      type: "compaction_end",
      reason: "threshold",
      result: { summary: "s", firstKeptEntryId: "e1", tokensBefore: 100000 },
      aborted: false,
      willRetry: false,
    });
    evt({ type: "agent_settled" });

    const messages = useStore.getState().sessions["s-compact-settle"]?.messages ?? [];
    // 流式 assistant 被定格（streaming=false），没有被 notice 挡住而永远转圈
    const assistant = messages.find((m) => m.id === "a1");
    expect(assistant?.streaming).toBe(false);
    const thinking = assistant?.segments[0];
    expect(thinking?.kind === "thinking" && thinking.done).toBe(true);
    // notice 仍在末尾
    expect(messages[messages.length - 1]?.role).toBe("notice");
  });
});

describe("groupMessagesForRender：notice 分组", () => {
  it("notice 独立成组，不打断前后运行的归属", () => {
    const msg = (id: string, role: "user" | "assistant" | "notice"): ChatMessage => ({
      id,
      role,
      segments: [],
      streaming: false,
      ...(role === "notice" ? { notice: { kind: "compaction" as const } } : {}),
    });
    const items = groupMessagesForRender([
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("n1", "notice"),
      msg("a2", "assistant"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "run", "notice", "run"]);
    expect(items[3]?.kind === "run" && items[3].messages.map((m) => m.id)).toEqual(["a2"]);
  });
});

describe("compactSession 手动压缩", () => {
  it("向宿主发送 session.compact 命令；运行中/草稿会话不发送", async () => {
    stubSpcodeApi();
    const spy = window.spcode.command as ReturnType<typeof vi.fn>;
    seedSession("s-manual-compact");
    await useStore.getState().compactSession();
    expect(spy.mock.calls.some((c) => (c[0] as { type?: string }).type === "session.compact")).toBe(true);

    // 运行中：不重复发起（手动压缩会先 abort 运行，不在中途插入）
    spy.mockClear();
    useStore.setState((s) => {
      const sess = s.sessions["s-manual-compact"];
      if (!sess) return s;
      return {
        sessions: { ...s.sessions, "s-manual-compact": { ...sess, running: true } },
      };
    });
    await useStore.getState().compactSession();
    expect(spy.mock.calls.some((c) => (c[0] as { type?: string }).type === "session.compact")).toBe(false);
  });
});
