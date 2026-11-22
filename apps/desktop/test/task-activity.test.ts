/**
 * 子任务活动事件（session.task wire）专项：
 * - normalizeTaskActivity 测试向量：合法载荷往返、长度截断、非法字段回退、垃圾输入拒绝
 * - createTaskTool 直驱（fauxProvider 真跑子会话）：
 *   queued → running → 工具边界进度（lastTool/turns/usage）→ 终态（status/summary/endedAt）
 * - 嵌套子任务事件带 depth=1 与 parentTaskId（ctx 展开继承 emitTask）
 * - 取消传播：外部 signal abort → 终态 cancelled
 * - 终态矩阵：error 终止无产出 → failed；工具全失败 → blocked；部分成功后异常 → partial
 * - 聊天行 onUpdate 实时状态文本（i18n agent:tool.taskProgress）
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { setLocale } from "@spcode/shared/i18n";
import { normalizeTaskActivity, TASK_ACTIVITY_SUMMARY_MAX_CHARS, type TaskActivity } from "@spcode/shared/task-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskTool, type TaskToolContext } from "../src/agent-host/tools/task.js";

const dirs: string[] = [];
afterEach(() => {
  setLocale("zh-CN");
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("normalizeTaskActivity wire 向量", () => {
  it("宿主产出的合法快照往返无损（渲染层消费口径）", () => {
    const activity: TaskActivity = {
      schemaVersion: 1,
      taskId: "task-1",
      parentTaskId: null,
      sourceToolCallId: "call-9",
      description: "读取配置",
      role: "readonly",
      depth: 0,
      status: "running",
      startedAt: 1000,
      updatedAt: 2000,
      turns: 3,
      maxTurns: 64,
      usage: { input: 120, output: 80, cacheRead: 40, cacheWrite: 0, costTotal: 0.01 },
      lastTool: "grep",
    };
    expect(normalizeTaskActivity(activity)).toEqual(activity);
    const terminal: TaskActivity = {
      ...activity,
      status: "completed",
      endedAt: 3000,
      summary: "结论摘要",
    };
    expect(normalizeTaskActivity(terminal)).toEqual(terminal);
  });

  it("截断超长字符串、钳制非法数值、未知状态回退 running", () => {
    const normalized = normalizeTaskActivity({
      taskId: "t",
      parentTaskId: "p".repeat(64),
      sourceToolCallId: "s".repeat(300),
      description: "d".repeat(500),
      role: "write",
      depth: 99,
      status: "exploded",
      startedAt: -5,
      updatedAt: "soon",
      endedAt: -1,
      turns: "3",
      maxTurns: Number.NaN,
      usage: { input: -1, output: "x", cacheRead: 1.5, cacheWrite: Number.POSITIVE_INFINITY, costTotal: 1 },
      lastTool: "read".repeat(50),
      summary: "z".repeat(TASK_ACTIVITY_SUMMARY_MAX_CHARS + 10),
    });
    expect(normalized).toMatchObject({
      taskId: "t",
      parentTaskId: "p".repeat(64),
      sourceToolCallId: "s".repeat(128),
      description: "d".repeat(200),
      role: "write",
      depth: 8,
      status: "running",
      startedAt: 0,
      updatedAt: 0,
      turns: 0,
      maxTurns: 0,
      usage: { input: 0, output: 0, cacheRead: 1.5, cacheWrite: 0, costTotal: 1 },
      lastTool: "read".repeat(16),
      summary: "z".repeat(TASK_ACTIVITY_SUMMARY_MAX_CHARS),
    });
    expect("endedAt" in (normalized ?? {})).toBe(false);
  });

  it("结构不可用直接拒绝：null / 非对象 / 缺 taskId", () => {
    expect(normalizeTaskActivity(null)).toBeNull();
    expect(normalizeTaskActivity("task")).toBeNull();
    expect(normalizeTaskActivity({})).toBeNull();
    expect(normalizeTaskActivity({ taskId: "" })).toBeNull();
  });
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "spcode-task-activity-"));
  dirs.push(dir);
  vi.stubEnv("SPCODE_HOME", join(dir, "home"));
  mkdirSync(join(dir, "project"), { recursive: true });
  writeFileSync(join(dir, "project", "sample.txt"), "sample content\n");
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    allowModelNetwork: false,
  });
  const faux = fauxProvider();
  runtime.registerNativeProvider(faux.provider);
  return {
    dir,
    faux,
    context: {
      cwd: join(dir, "project"),
      agentDir: join(dir, "agent"),
      sessionId: "task-activity-test",
      modelRuntime: runtime,
      model: faux.getModel() as never,
      thinkingLevel: "off",
      depth: 0,
      requestPermission: async () => true,
      // 生产接线必带（SessionController 创建 evidence store）；直驱测试给桩避免“未接证据持久化”进入 unresolved
      publishEvidence: () => [],
    } satisfies Omit<TaskToolContext, "emitTask">,
  };
}

describe("createTaskTool 活动事件全链路", () => {
  it("queued → running → 工具边界进度 → 终态 completed（含 summary/endedAt/usage）", async () => {
    setLocale("zh-CN");
    const f = await fixture();
    const events: TaskActivity[] = [];
    const updates: { text: string }[] = [];
    f.faux.setResponses([
      () =>
        fauxAssistantMessage(fauxToolCall("read", { path: join(f.dir, "project", "sample.txt") }), {
          stopReason: "toolUse",
        }),
      () => fauxAssistantMessage("子代理结论原文"),
    ]);
    const task = createTaskTool({
      ...f.context,
      emitTask: (activity) => events.push(structuredClone(activity)),
    });
    const result = await task.execute(
      "root-call",
      { description: "读取样例文件", prompt: "读取 sample.txt 并总结" },
      undefined,
      (partial) => {
        const text = partial.content[0];
        if (text?.type === "text") updates.push({ text: text.text });
      },
    );

    // 事件序列：首条 queued（parentTaskId=null 指向根会话），随后 running，终态 completed
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events[0]).toMatchObject({
      status: "queued",
      parentTaskId: null,
      sourceToolCallId: "root-call",
      description: "读取样例文件",
      role: "readonly",
      depth: 0,
      turns: 0,
      maxTurns: 64,
    });
    expect(events.some((e) => e.status === "running")).toBe(true);
    const terminal = events.at(-1)!;
    expect(terminal).toMatchObject({
      status: "completed",
      sourceToolCallId: "root-call",
      endedAt: expect.any(Number),
      summary: "子代理结论原文",
      lastTool: "read",
      turns: expect.any(Number),
    });
    expect(terminal.turns).toBeGreaterThan(0);
    // 进度事件携带工具边界信息；每条事件都能无损通过 wire 归一化（向量锁死）
    expect(events.some((e) => e.status === "running" && e.lastTool === "read")).toBe(true);
    for (const event of events) expect(normalizeTaskActivity(event)).toEqual(event);
    // 同一 taskId 覆盖式更新
    expect(new Set(events.map((e) => e.taskId)).size).toBe(1);

    // 聊天行实时状态：首条 queued 行 + 后续 running 行（含描述与工具名）
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[0]!.text).toContain("读取样例文件");
    expect(updates[0]!.text).toContain("0/64");
    expect(updates.some((u) => u.text.includes("read"))).toBe(true);

    // 工具结果保持既有结构化交接契约
    expect(result.details).toMatchObject({
      description: "读取样例文件",
      presentation: { key: "agent:tool.taskResult", params: { result: "子代理结论原文" } },
    });
  }, 60000);

  it("嵌套子任务事件带 depth=1 与 parentTaskId（ctx 展开继承 emitTask）", async () => {
    setLocale("zh-CN");
    const f = await fixture();
    const events: TaskActivity[] = [];
    f.faux.setResponses([
      // 外层子会话派生嵌套 Task
      () =>
        fauxAssistantMessage(fauxToolCall("Task", { description: "嵌套任务", prompt: "嵌套子任务说明" }), {
          stopReason: "toolUse",
        }),
      // 嵌套子会话直接给结论
      () => fauxAssistantMessage("嵌套结论"),
      // 外层子会话总结
      () => fauxAssistantMessage("外层结论"),
    ]);
    const task = createTaskTool({
      ...f.context,
      emitTask: (activity) => events.push(structuredClone(activity)),
    });
    await task.execute("outer-call", { description: "外层任务", prompt: "派生一个嵌套任务" }, undefined);

    const outerEvents = events.filter((e) => e.sourceToolCallId === "outer-call");
    const nestedEvents = events.filter((e) => e.sourceToolCallId !== "outer-call");
    expect(outerEvents.length).toBeGreaterThanOrEqual(3);
    expect(nestedEvents.length).toBeGreaterThanOrEqual(3);
    const outerId = outerEvents[0]!.taskId;
    for (const nested of nestedEvents) {
      expect(nested.parentTaskId).toBe(outerId);
      expect(nested.depth).toBe(1);
      expect(nested.description).toBe("嵌套任务");
    }
    expect(nestedEvents.at(-1)).toMatchObject({ status: "completed", summary: "嵌套结论" });
    expect(outerEvents.at(-1)).toMatchObject({ status: "completed", summary: "外层结论" });
  }, 60000);

  it("子代理异常终止（stopReason=error）且无成功产出 → 终态 failed", async () => {
    setLocale("zh-CN");
    const f = await fixture();
    const events: TaskActivity[] = [];
    f.faux.setResponses([() => fauxAssistantMessage("出错前的部分输出", { stopReason: "error" })]);
    const task = createTaskTool({
      ...f.context,
      emitTask: (activity) => events.push(structuredClone(activity)),
    });
    const result = await task.execute("error-call", { description: "会失败的任务", prompt: "随便做点什么" }, undefined);

    // 引擎侧以 error stopReason 结束：无成功工具产出 → 终态必须是 failed（不是 partial）
    const terminal = events.at(-1)!;
    expect(terminal).toMatchObject({ status: "failed", sourceToolCallId: "error-call", endedAt: expect.any(Number) });
    const handoff = JSON.parse((result.content[0] as { text: string }).text) as {
      status: string;
      unresolved: string[];
    };
    expect(handoff.status).toBe("failed");
    expect(handoff.unresolved.length).toBeGreaterThan(0);
  }, 60000);

  it("工具全部失败 → 终态 blocked", async () => {
    setLocale("zh-CN");
    const f = await fixture();
    const events: TaskActivity[] = [];
    f.faux.setResponses([
      () =>
        fauxAssistantMessage(fauxToolCall("read", { path: join(f.dir, "project", "missing.txt") }), {
          stopReason: "toolUse",
        }),
      () => fauxAssistantMessage("工具全失败后的结论"),
    ]);
    const task = createTaskTool({
      ...f.context,
      emitTask: (activity) => events.push(structuredClone(activity)),
    });
    const result = await task.execute(
      "blocked-call",
      { description: "会被工具拒绝", prompt: "读取一个不存在的文件" },
      undefined,
    );

    expect(events.at(-1)).toMatchObject({ status: "blocked", sourceToolCallId: "blocked-call" });
    const handoff = JSON.parse((result.content[0] as { text: string }).text) as { status: string };
    expect(handoff.status).toBe("blocked");
  }, 60000);

  it("部分成功后异常终止 → 终态 partial", async () => {
    setLocale("zh-CN");
    const f = await fixture();
    const events: TaskActivity[] = [];
    f.faux.setResponses([
      () =>
        fauxAssistantMessage(fauxToolCall("read", { path: join(f.dir, "project", "sample.txt") }), {
          stopReason: "toolUse",
        }),
      () => fauxAssistantMessage("成功过但随后出错", { stopReason: "error" }),
    ]);
    const task = createTaskTool({
      ...f.context,
      emitTask: (activity) => events.push(structuredClone(activity)),
    });
    const result = await task.execute(
      "partial-call",
      { description: "部分成功的任务", prompt: "先读文件再出错" },
      undefined,
    );

    // 有成功产出 + error 终止：成功部分保留语义，终态 partial
    expect(events.at(-1)).toMatchObject({ status: "partial", sourceToolCallId: "partial-call" });
    const handoff = JSON.parse((result.content[0] as { text: string }).text) as { status: string };
    expect(handoff.status).toBe("partial");
  }, 60000);

  it("外部 signal 中途 abort → 终态 cancelled 事件与取消结果", async () => {
    setLocale("zh-CN");
    const f = await fixture();
    const events: TaskActivity[] = [];
    const task = createTaskTool({
      ...f.context,
      emitTask: (activity) => events.push(structuredClone(activity)),
    });
    const controller = new AbortController();
    const pending = task.execute("cancel-call", { description: "会被取消", prompt: "随便做点什么" }, controller.signal);
    controller.abort();
    const result = await pending;

    expect(events[0]).toMatchObject({ status: "queued", sourceToolCallId: "cancel-call" });
    expect(events.at(-1)).toMatchObject({ status: "cancelled", endedAt: expect.any(Number) });
    const handoff = JSON.parse((result.content[0] as { text: string }).text) as { status: string };
    expect(handoff.status).toBe("cancelled");
  }, 60000);
});
