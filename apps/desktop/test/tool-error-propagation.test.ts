import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createSandboxedBashTool } from "../src/agent-host/sandbox/bash-tool.js";
import { createBashToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

function usage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function streamOf(message: AssistantMessage): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: message.stopReason, message });
  stream.end();
  return stream;
}

describe("Agent tool error propagation", () => {
  it("保留工具结果中的 isError=true", async () => {
    const tool: ToolDefinition = {
      ...createBashToolDefinition(process.cwd()),
      name: "test-error",
      label: "test-error",
      description: "return an error result",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "expected tool error" }], isError: true }),
    };
    const toolCall: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "test-error", arguments: {} }],
      api: "anthropic-messages",
      provider: "test",
      model: "test",
      usage: usage(),
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
    const done: AssistantMessage = {
      ...toolCall,
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    let turn = 0;
    const agent = new Agent({ streamFn: async () => streamOf(++turn === 1 ? toolCall : done) });
    agent.state.tools = [tool];
    const events: AgentMessage[] = [];
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end") events.push(event.result);
    });

    await agent.prompt("run");

    const result = agent.state.messages.find((message) => message.role === "toolResult");
    expect(result?.role).toBe("toolResult");
    if (result?.role !== "toolResult") throw new Error("missing toolResult");
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: "expected tool error" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ isError: true });
  });

  it("同一批次的独立 Bash 调用真实并行", async () => {
    const makeTool = (name: string) => ({
      ...createSandboxedBashTool(process.cwd(), { allowBypass: false, sandboxEnabled: false }),
      name,
      label: name,
    });
    const starts: Record<string, number> = {};
    const ends: Record<string, number> = {};
    const timed = (tool: ReturnType<typeof makeTool>, key: string): ToolDefinition => ({
      ...tool,
      execute: async (id, args, signal, onUpdate, ctx) => {
        starts[key] = Date.now();
        try {
          return await tool.execute(id, args, signal, onUpdate, ctx);
        } finally {
          ends[key] = Date.now();
        }
      },
    });
    const a = timed(makeTool("slow-a"), "a");
    const b = timed(makeTool("slow-b"), "b");
    const batch: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-a", name: "slow-a", arguments: { command: "sleep 0.4; echo A" } },
        { type: "toolCall", id: "call-b", name: "slow-b", arguments: { command: "sleep 0.4; echo B" } },
      ],
      api: "anthropic-messages",
      provider: "test",
      model: "test",
      usage: usage(),
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
    const done: AssistantMessage = {
      ...batch,
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    let turn = 0;
    const agent = new Agent({ streamFn: async () => streamOf(++turn === 1 ? batch : done) });
    agent.state.tools = [a, b];

    await agent.prompt("run");

    const overlap = Math.min(ends.a ?? 0, ends.b ?? 0) - Math.max(starts.a ?? 0, starts.b ?? 0);
    expect(overlap).toBeGreaterThan(200);
  });
});
