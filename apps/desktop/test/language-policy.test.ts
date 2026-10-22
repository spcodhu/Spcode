import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Message,
  normalizeContext,
  resolveTranscript,
  type TranscriptContext,
  Type,
} from "@earendil-works/pi-ai";
import { type AgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { i18n, setLocale } from "@spcode/shared/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLanguagePolicy,
  installLanguagePolicy,
  LANGUAGE_POLICY_SECTION,
} from "../src/agent-host/language-policy.js";
import { MemoryStore } from "../src/agent-host/memory-store.js";
import { SessionController, type SessionControllerOptions } from "../src/agent-host/session-controller.js";
import { createTaskTool } from "../src/agent-host/tools/task.js";
import { createTodoWriteTool } from "../src/agent-host/tools/todowrite.js";

const dirs: string[] = [];
const controllers: SessionController[] = [];
afterEach(async () => {
  for (const ctl of controllers.splice(0)) await ctl.dispose();
  setLocale("zh-CN");
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "spcode-language-"));
  dirs.push(dir);
  vi.stubEnv("SPCODE_HOME", join(dir, "home"));
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    allowModelNetwork: false,
  });
  const faux = fauxProvider();
  runtime.registerNativeProvider(faux.provider);
  const options: SessionControllerOptions = {
    sessionId: "language-test",
    cwd: join(dir, "project"),
    agentDir: join(dir, "agent"),
    memoryStore: new MemoryStore(join(dir, "home")),
    modelRuntime: runtime,
    modelRef: { provider: faux.getModel().provider, modelId: faux.getModel().id },
    noTitleAutomation: true,
    isDistillEnabled: () => false,
    emitEvent: () => {},
    emitUsage: () => {},
    emitTodo: () => {},
    emitPlanMode: () => {},
    emitPlan: () => {},
    requestPermission: async () => true,
    askQuestion: async () => ({}),
  };
  async function create(extra: Partial<SessionControllerOptions> = {}) {
    const ctl = await SessionController.create({ ...options, ...extra });
    controllers.push(ctl);
    return ctl;
  }
  return { dir, runtime, faux, options, create };
}

function assertLanguage(context: TranscriptContext, locale: "zh-CN" | "en") {
  for (const supportsMidConvo of [true, false]) {
    const resolved = resolveTranscript(context, supportsMidConvo);
    expect(getCurrentSystemPrompt(resolved.messages)).toContain(buildLanguagePolicy(locale));
    expect(resolved.messages.at(-1)?.role).not.toBe("system");
  }
}

describe("request language policy", () => {
  it("TodoWrite keeps model text and todos raw while fixed presentation can change locale", async () => {
    const emit = vi.fn();
    const todos = [{ content: "原始任务 src/a.ts", activeForm: "原始进行中", status: "completed" }];
    const result = await createTodoWriteTool(emit).execute("todo", { todos }, undefined as never);
    expect(emit).toHaveBeenCalledWith(todos);
    expect(result.content[0]).toMatchObject({ text: "Todo list updated: 1/1 completed." });
    expect(result.details).toEqual({
      todos,
      presentation: { key: "agent:tool.todosUpdated", params: { done: 1, total: 1 } },
    });
    setLocale("en");
    expect(i18n.t("agent:tool.todosUpdated", { done: 1, total: 1 })).toBe("Todo list updated: 1/1 completed.");
    setLocale("zh-CN");
    expect(i18n.t("agent:tool.todosUpdated", { done: 1, total: 1 })).toBe("任务清单已更新：已完成 1/1。");
    expect(todos[0]!.content).toBe("原始任务 src/a.ts");
  });

  it("runs the previous hook first, preserves section/tool deltas, and never mutates history", async () => {
    const history: Message[] = [
      {
        role: "system",
        content: "base",
        sections: { memory: "原文", keep: "keep" },
        toolsAdded: [{ name: "old", description: "old", parameters: Type.Object({}) }],
        timestamp: 0,
      },
      { role: "user", content: "请保留 `src/文件.ts` and 'quoted text'", timestamp: 1 },
      {
        role: "system",
        content: "delta",
        sections: { keep: null, extra: "extension" },
        toolsRemoved: [{ name: "old" }],
        toolsAdded: [{ name: "new", description: "new", parameters: Type.Object({}) }],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "t",
        toolName: "new",
        content: [{ type: "text", text: "原始结果" }],
        isError: false,
        timestamp: 3,
      },
    ];
    const before = structuredClone(history);
    const signal = new AbortController().signal;
    const previous = vi.fn(async (messages: Message[]) => {
      setLocale("en"); // must be observed AFTER the awaited extension hook
      return messages.map((message, index) =>
        index === 0 && message.role === "system"
          ? { ...message, sections: { ...message.sections, hook: "previous hook result" } }
          : message,
      );
    });
    const agent = { transformContext: previous } as Pick<AgentSession["agent"], "transformContext">;
    installLanguagePolicy(agent);
    const projected = await agent.transformContext!(history, signal);
    expect(previous).toHaveBeenCalledWith(history, signal);
    expect(history).toEqual(before);
    expect(projected[1]).toBe(history[1]);
    expect(projected.at(-1)).toBe(history.at(-1));
    expect(projected[2]).toEqual(history[2]);
    const context = normalizeContext({ messages: projected as Message[] });
    assertLanguage(context, "en");
    expect(getCurrentTools(context.messages).map((t) => t.name)).toEqual(["new"]);
    expect(getCurrentSystemPrompt(context.messages)).toContain("原文");
    expect(getCurrentSystemPrompt(context.messages)).toContain("extension");

    const bare = { transformContext: undefined } as Pick<AgentSession["agent"], "transformContext">;
    installLanguagePolicy(bare);
    const noSystem = await bare.transformContext!([history[1]!], signal);
    expect(noSystem[0]?.role).toBe("system");
    expect(noSystem.at(-1)).toBe(history[1]);
    const twice = await bare.transformContext!(noSystem, signal);
    expect(twice).toEqual(noSystem); // idempotent if a caller reuses a projection
  });

  it("captures latest locale at normalized provider requests for tool continuation, steering, and prompt", async () => {
    const f = await fixture();
    const ctl = await f.create();
    const captured: TranscriptContext[] = [];
    const input = "请检查 src/文件.ts; explicit task: write the README in French";
    setLocale("zh-CN");
    f.faux.setResponses([
      (context) => {
        captured.push(structuredClone(context));
        setLocale("en"); // switching during this response cannot rewrite it
        return fauxAssistantMessage(
          fauxToolCall("TodoWrite", { todos: [{ content: "检查文件", status: "completed" }] }),
          { stopReason: "toolUse" },
        );
      },
      async (context) => {
        captured.push(structuredClone(context));
        setLocale("zh-CN");
        await ctl.prompt("插话原文 /tmp/raw.ts");
        return fauxAssistantMessage("Original English response");
      },
      (context) => {
        captured.push(structuredClone(context));
        return fauxAssistantMessage("新的中文回复");
      },
      (context) => {
        captured.push(structuredClone(context));
        return fauxAssistantMessage("Next English response");
      },
    ]);
    await ctl.prompt(input);
    setLocale("en");
    await ctl.prompt("普通中文输入不决定输出语言");
    expect(captured).toHaveLength(4);
    ["zh-CN", "en", "zh-CN", "en"].forEach((locale, i) => {
      assertLanguage(captured[i]!, locale as "zh-CN" | "en");
    });
    expect(captured[1]!.messages.at(-1)?.role).toBe("toolResult");
    expect(captured[2]!.messages.at(-1)?.role).toBe("user");
    expect(JSON.stringify(captured[0])).toContain(input);
    expect(JSON.stringify(ctl.history())).not.toContain(LANGUAGE_POLICY_SECTION);
    expect(JSON.stringify(ctl.history())).toContain(input);
    expect(JSON.stringify(ctl.history())).toContain("Original English response");
    expect(getCurrentSystemPrompt(captured[3]!.messages)).toContain("Honor an explicit user request");
    expect(getCurrentSystemPrompt(captured[3]!.messages)).toContain(
      "Do not change the language of internal thinking/reasoning",
    );
  }, 60000);

  it("restored and forked sessions apply the locale on their next model request", async () => {
    const f = await fixture();
    const original = await f.create();
    f.faux.setResponses([fauxAssistantMessage("历史内容 unchanged")]);
    await original.prompt("原始用户请求");
    const file = original.sessionFile!;
    await original.dispose();
    controllers.splice(controllers.indexOf(original), 1);
    const captured: TranscriptContext[] = [];
    f.faux.setResponses([
      (context) => {
        captured.push(structuredClone(context));
        return fauxAssistantMessage("resumed");
      },
      (context) => {
        captured.push(structuredClone(context));
        return fauxAssistantMessage("forked");
      },
    ]);
    setLocale("en");
    const resumed = await f.create({ sessionFile: file, planMode: true });
    await resumed.prompt("恢复会话");
    const fork = await f.create({ sessionManager: SessionManager.forkFrom(file, f.options.cwd, join(f.dir, "forks")) });
    await fork.prompt("分支会话");
    expect(captured).toHaveLength(2);
    for (const context of captured) {
      assertLanguage(context, "en");
      expect(JSON.stringify(context)).toContain("历史内容 unchanged");
    }
    expect(getCurrentTools(captured[0]!.messages).map((t) => t.name)).toContain("WritePlan");
    expect(JSON.stringify(resumed.history())).not.toContain(LANGUAGE_POLICY_SECTION);
    expect(JSON.stringify(fork.history())).not.toContain(LANGUAGE_POLICY_SECTION);
  }, 60000);

  it("recursive Task subagents share the request policy and keep conclusions raw", async () => {
    const f = await fixture();
    const captured: TranscriptContext[] = [];
    setLocale("zh-CN");
    f.faux.setResponses([
      (context) => {
        captured.push(structuredClone(context));
        setLocale("en");
        return fauxAssistantMessage(
          fauxToolCall("Task", { description: "Read nested file", prompt: "nested prompt 原文" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        captured.push(structuredClone(context));
        return fauxAssistantMessage("Nested conclusion /tmp/raw.ts");
      },
      (context) => {
        captured.push(structuredClone(context));
        return fauxAssistantMessage("Final conclusion 原文");
      },
    ]);
    const task = createTaskTool({
      cwd: f.options.cwd,
      agentDir: f.options.agentDir,
      modelRuntime: f.runtime,
      model: f.faux.getModel() as never,
      thinkingLevel: "off",
      depth: 0,
      requestPermission: async () => true,
    });
    const result = await task.execute(
      "t",
      { description: "任务描述", prompt: "Read files 原始任务" },
      undefined as never,
    );
    expect(captured).toHaveLength(3);
    assertLanguage(captured[0]!, "zh-CN");
    assertLanguage(captured[1]!, "en");
    assertLanguage(captured[2]!, "en");
    expect(getCurrentTools(captured[1]!.messages).map((t) => t.name)).not.toContain("Task");
    expect(result.details).toMatchObject({
      description: "任务描述",
      presentation: { key: "agent:tool.taskResult", params: { result: "Final conclusion 原文" } },
    });
    expect(result.content[0]).toMatchObject({ text: "# Subagent result: 任务描述\n\nFinal conclusion 原文" });
  }, 60000);
});
