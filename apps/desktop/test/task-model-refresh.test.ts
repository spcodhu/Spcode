/**
 * 回归（R6 P1-1）：Task 子代理 spawn 时必须实时读主会话当前模型。
 * 修复前 createTaskTool 闭包持有会话创建时的模型对象快照：设置页编辑模型
 * （refreshModelFromRegistry）或中途切模型（setModel）后主会话用新对象，
 * 子代理仍用旧对象——compat 修复（如千问 developer 角色 400）在委派路径复现。
 * 用两个 fauxProvider 全链路真跑：主会话 A 切到 B 后委派 Task，断言子会话
 * 拿到的是 B 的当前对象（createAgentSession 包装捕获，不拦截真实行为）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/agent-host/memory-store.js";
import { SessionController } from "../src/agent-host/session-controller.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: vi.fn(actual.createAgentSession) };
});

const dirs: string[] = [];
const controllers: SessionController[] = [];
afterEach(async () => {
  for (const ctl of controllers.splice(0)) await ctl.dispose();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.mocked(createAgentSession).mockClear();
});

/** 子代理的 createAgentSession 不带 resourceLoader（主会话带），据此过滤 */
function subagentCalls() {
  return vi
    .mocked(createAgentSession)
    .mock.calls.map(([opts]) => opts)
    .filter((opts) => !(opts as { resourceLoader?: unknown }).resourceLoader);
}

describe("Task 子代理模型实时快照", () => {
  it("主会话切模型后，子代理用当前模型对象而非创建时快照", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spcode-task-model-"));
    dirs.push(dir);
    vi.stubEnv("SPCODE_HOME", join(dir, "home"));
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      allowModelNetwork: false,
    });
    const fauxA = fauxProvider({ provider: "faux-a" });
    const fauxB = fauxProvider({ provider: "faux-b" });
    runtime.registerNativeProvider(fauxA.provider);
    runtime.registerNativeProvider(fauxB.provider);

    // 切模型后主会话与子代理都走 B：主会话先委派 Task，子代理给结论，主会话收尾
    fauxB.setResponses([
      () =>
        fauxAssistantMessage([fauxToolCall("Task", { description: "子任务", prompt: "读文件并总结" })], {
          stopReason: "toolUse",
        }),
      () => fauxAssistantMessage("子代理结论"),
      () => fauxAssistantMessage("完成"),
    ]);

    const ctl = await SessionController.create({
      sessionId: "task-model-refresh",
      cwd: join(dir, "project"),
      agentDir: join(dir, "agent"),
      memoryStore: new MemoryStore(join(dir, "home")),
      modelRuntime: runtime,
      modelRef: { provider: "faux-a", modelId: fauxA.getModel().id },
      noTitleAutomation: true,
      isDistillEnabled: () => false,
      emitEvent: () => {},
      emitUsage: () => {},
      emitTodo: () => {},
      emitPlanMode: () => {},
      emitPlan: () => {},
      requestPermission: async () => true,
      askQuestion: async () => ({}),
    });
    controllers.push(ctl);

    // 中途切到 B（与 refreshModelFromRegistry 同一 getter 路径：session.model 实时值）
    const modelB = runtime.getModel("faux-b", fauxB.getModel().id)!;
    await ctl.setModel({ provider: "faux-b", modelId: fauxB.getModel().id });
    expect(ctl.session.model).toBe(modelB);

    await ctl.prompt("派活");

    const calls = subagentCalls();
    expect(calls).toHaveLength(1);
    for (const opts of calls) {
      expect((opts as { model?: unknown }).model).toBe(modelB);
    }
  }, 60000);
});
