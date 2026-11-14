import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTurnContext } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_MODEL_TURNS,
  DEFAULT_SETTINGS,
  type RunGuardCustomDetails,
  type RunGuardPause,
} from "@spcode/shared";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/agent-host/memory-store.js";
import { canonicalizeToolArguments, RunGuard } from "../src/agent-host/run-guard.js";
import { SessionController } from "../src/agent-host/session-controller.js";
import { sanitizeAppSettings } from "../src/main/settings-store.js";

function usage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(content: unknown[], stopReason: "toolUse" | "stop" = "toolUse"): AssistantMessage {
  return {
    role: "assistant",
    content: content as AssistantMessage["content"],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: usage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function turn(calls: { name: string; arguments: unknown }[]): AgentTurnContext {
  return {
    message: assistant(calls.map((call, index) => ({ type: "toolCall", id: `call-${index}`, ...call }))),
    toolResults: [],
    context: { messages: [] },
    newMessages: [],
  } as AgentTurnContext;
}

function streamOf(message: AssistantMessage): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: message.stopReason, message });
  stream.end();
  return stream;
}

function guardHarness(maxTurns = 2000) {
  const contexts: { content: string; details: RunGuardCustomDetails }[] = [];
  const pauses: RunGuardPause[] = [];
  const guard = new RunGuard(() => maxTurns, {
    appendContext: async (content, details) => {
      contexts.push({ content, details });
    },
    emitPause: (pause) => pauses.push(pause),
  });
  return { guard, contexts, pauses };
}

describe("RunGuard 连续相同工具调用检测", () => {
  it("参数深度规范化；第 3 次提醒、第 5 次暂停，之后不再发起新回合", async () => {
    expect(canonicalizeToolArguments({ b: [1, { y: 2, x: 1 }], a: true })).toBe(
      canonicalizeToolArguments({ a: true, b: [1, { x: 1, y: 2 }] }),
    );
    const { guard, contexts, pauses } = guardHarness();
    for (let i = 1; i <= 5; i++) {
      const decision = await guard.finishTurn(turn([{ name: "probe", arguments: { q: { b: 2, a: 1 } } }]), true);
      expect(decision).toEqual(i === 5 ? { action: "end" } : undefined);
    }
    expect(contexts.map((item) => item.details.kind)).toEqual(["reminder", "pause"]);
    expect(pauses).toEqual([
      {
        reason: "repeatTool",
        turnCount: 5,
        toolName: "probe",
        repeatCount: 5,
        argumentsPreview: '{"q":{"a":1,"b":2}}',
      },
    ]);
    expect((await guard.finishTurn(turn([]), true))?.action).toBe("end");
  });

  it("不同调用重置链；TodoWrite 透明；用户插话后重新计数", async () => {
    const { guard, contexts, pauses } = guardHarness();
    const same = (name = "probe") => turn([{ name, arguments: { q: 1 } }]);
    await guard.finishTurn(same(), true);
    await guard.finishTurn(same("TodoWrite"), true); // 透明：不计数也不打断
    await guard.finishTurn(same(), true);
    await guard.finishTurn(same(), true);
    expect(contexts).toHaveLength(1); // 第三次有效 probe，仅提醒

    await guard.finishTurn(turn([{ name: "probe", arguments: { q: 2 } }]), true);
    await guard.finishTurn(same(), true);
    await guard.finishTurn(same(), true);
    expect(pauses).toHaveLength(0);

    guard.resetRepeatChain();
    await guard.finishTurn(same(), true);
    await guard.finishTurn(same(), true);
    expect(contexts).toHaveLength(1);
  });

  it("长参数只对展示截断，检测仍使用完整参数", async () => {
    const { guard, pauses } = guardHarness();
    const args = { body: "x".repeat(800) };
    for (let i = 0; i < 5; i++) await guard.finishTurn(turn([{ name: "write", arguments: args }]), true);
    expect(pauses[0]?.argumentsPreview).toContain("more chars");
    expect(pauses[0]?.argumentsPreview?.length).toBeLessThan(550);
  });
});

describe("RunGuard 模型回合预算与设置", () => {
  it("达到上限后阻止下一回合；自然 stop 不误报；reset 开启新预算", async () => {
    expect(DEFAULT_MAX_MODEL_TURNS).toBe(2000);
    expect(DEFAULT_SETTINGS.maxModelTurns).toBe(2000);
    const { guard, pauses } = guardHarness(2);
    expect(await guard.finishTurn(turn([]), true)).toBeUndefined();
    expect(await guard.finishTurn(turn([]), true)).toEqual({ action: "end" });
    expect(pauses[0]).toEqual({ reason: "maxTurns", turnCount: 2, limit: 2 });

    guard.reset();
    expect(await guard.finishTurn(turn([]), false)).toBeUndefined();
    expect(pauses).toHaveLength(1);
  });

  it("设置存储只接受正整数，非法值回落默认", () => {
    expect(sanitizeAppSettings({ maxModelTurns: 20 }).maxModelTurns).toBe(20);
    for (const value of [0, -1, 1.5, Number.NaN, "2000"] as const) {
      expect(sanitizeAppSettings({ maxModelTurns: value as number }).maxModelTurns).toBeUndefined();
    }
  });
});

describe("SessionController 运行保护集成", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("真实 AgentSession：五次相同调用暂停；用户继续后从当前上下文完成", async () => {
    dir = mkdtempSync(join(tmpdir(), "spcode-run-guard-"));
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          test: {
            name: "Test",
            baseUrl: "https://test.invalid/v1",
            api: "openai-completions",
            apiKey: "test-key",
            models: [
              {
                id: "test-model",
                name: "Test model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 100000,
                maxTokens: 4096,
              },
            ],
          },
        },
      }),
    );
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      allowModelNetwork: false,
    });
    const script: AssistantMessage[] = [];
    for (let i = 0; i < 5; i++) {
      script.push(assistant([{ type: "toolCall", id: `call-${i}`, name: "mcp__test__probe", arguments: { q: 1 } }]));
    }
    const streamMock = vi.spyOn(runtime, "streamSimple").mockImplementation(() => {
      const next = script.shift();
      if (!next) throw new Error("Guard allowed an unexpected extra model call");
      return streamOf(next);
    });
    let executions = 0;
    const probe: ToolDefinition = {
      name: "mcp__test__probe",
      label: "probe",
      description: "test probe",
      parameters: Type.Object({}),
      execute: async () => {
        executions += 1;
        return { content: [{ type: "text", text: "same result" }] };
      },
    };
    const pauses: RunGuardPause[] = [];
    const events: string[] = [];
    const ctl = await SessionController.create({
      sessionId: "guard-integration",
      cwd: join(dir, "scratch"),
      agentDir: dir,
      modelRuntime: runtime,
      modelRef: { provider: "test", modelId: "test-model" },
      memoryStore: new MemoryStore(join(dir, "home")),
      noTitleAutomation: true,
      isDistillEnabled: () => false,
      getMcpTools: () => [probe],
      emitRunGuard: (pause) => pauses.push(pause),
      emitEvent: (event) => events.push(event.type),
      emitUsage: () => {},
      emitTodo: () => {},
      emitPlanMode: () => {},
      emitPlan: () => {},
      requestPermission: async () => true,
      askQuestion: async () => ({}),
    });

    await ctl.prompt("run the loop fixture");
    expect(streamMock).toHaveBeenCalledTimes(5);
    expect(executions).toBe(5);
    expect(pauses.map((pause) => pause.reason)).toEqual(["repeatTool"]);
    expect(ctl.isRunning()).toBe(false);
    expect(events.filter((type) => type === "agent_settled")).toHaveLength(1);
    expect(
      ctl.history().some((raw) => {
        const message = raw as { role?: string; customType?: string; details?: { kind?: string } };
        return (
          message.role === "custom" && message.customType === "spcode.run-guard" && message.details?.kind === "pause"
        );
      }),
    ).toBe(true);

    script.push(assistant([{ type: "text", text: "finished after user continuation" }], "stop"));
    await ctl.continueAfterGuard();
    expect(streamMock).toHaveBeenCalledTimes(6);
    expect(ctl.isRunning()).toBe(false);
    expect(events.filter((type) => type === "agent_settled")).toHaveLength(2);
    expect(
      ctl.history().some((raw) => {
        const content = (raw as { content?: unknown }).content;
        return (
          Array.isArray(content) &&
          content.some((block) => (block as { text?: string }).text === "finished after user continuation")
        );
      }),
    ).toBe(true);
    await ctl.dispose();
  }, 30_000);
});
