/**
 * 子代理三档设置（subagentMode）测试：
 * - shared normalize 与默认值（prefer 保持现状）
 * - 策略段三档文案 + 请求级投影热更新/幂等/不写历史
 * - taskSessionToolNames off 不含 Task
 * - SessionController 集成：创建时工具集门禁、setSubagentMode 热切换、计划态交互
 *   （fauxProvider 捕获真实请求上下文，断言模型可见的工具与系统段）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Message,
  resolveTranscript,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { type AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, normalizeSubagentMode, type SubagentMode } from "@spcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/agent-host/memory-store.js";
import { SessionController, type SessionControllerOptions } from "../src/agent-host/session-controller.js";
import {
  buildSubagentPolicy,
  installSubagentPolicy,
  SUBAGENT_POLICY_SECTION,
} from "../src/agent-host/subagent-policy.js";
import { taskSessionToolNames } from "../src/agent-host/tools/task.js";

const dirs: string[] = [];
const controllers: SessionController[] = [];
afterEach(async () => {
  for (const ctl of controllers.splice(0)) await ctl.dispose();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("subagentMode 归一化与默认值", () => {
  it("三档合法值原样保留，非法值返回 null", () => {
    for (const mode of ["prefer", "direct", "off"] as const) expect(normalizeSubagentMode(mode)).toBe(mode);
    for (const bad of ["yolo", "", null, undefined, 1, {}]) expect(normalizeSubagentMode(bad)).toBeNull();
  });

  it("出厂默认 prefer（保持既有行为）", () => {
    expect(DEFAULT_SETTINGS.subagentMode).toBe("prefer");
  });
});

describe("buildSubagentPolicy 三档文案", () => {
  it("互异且语义正确：off 声明禁用、direct 声明覆盖工具描述偏好、prefer 鼓励委派", () => {
    const prefer = buildSubagentPolicy("prefer");
    const direct = buildSubagentPolicy("direct");
    const off = buildSubagentPolicy("off");
    expect(new Set([prefer, direct, off]).size).toBe(3);
    expect(off).toContain("disabled by the user");
    expect(direct).toContain("prefers direct implementation");
    expect(direct).toContain("overrides any delegation preference");
    expect(prefer).toContain("prefers delegating");
    for (const text of [prefer, direct, off]) expect(text).toContain("<subagent-policy>");
  });
});

describe("installSubagentPolicy 请求级投影", () => {
  it("逐请求快照 getter（热更新）、保留段替换幂等、不改非系统消息", async () => {
    let mode: SubagentMode = "prefer";
    const agent = { transformContext: undefined } as Pick<AgentSession["agent"], "transformContext">;
    installSubagentPolicy(agent, () => mode);
    const history: Message[] = [
      { role: "system", content: "base", sections: { keep: "keep" }, timestamp: 0 },
      { role: "user", content: "hi", timestamp: 1 },
    ];
    const signal = new AbortController().signal;
    const first = await agent.transformContext!(history, signal);
    expect(first[0]!.sections?.[SUBAGENT_POLICY_SECTION]).toBe(buildSubagentPolicy("prefer"));
    expect(first[0]!.sections?.keep).toBe("keep");
    expect(first[1]).toBe(history[1]);
    // 热更新：同一投影复用时只替换保留段
    mode = "off";
    const second = await agent.transformContext!(first, signal);
    expect(second[0]!.sections?.[SUBAGENT_POLICY_SECTION]).toBe(buildSubagentPolicy("off"));
    const third = await agent.transformContext!(second, signal);
    expect(third).toEqual(second);
    // 首条非 system 时兜底 unshift，末条保持非 system
    const bare = await agent.transformContext!([history[1]!], signal);
    expect(bare[0]?.role).toBe("system");
    expect(bare.at(-1)?.role).toBe("user");
  });
});

describe("taskSessionToolNames 三档", () => {
  it("off 任何深度都不含 Task；prefer 按深度上限提供", () => {
    expect(taskSessionToolNames(0, "off")).not.toContain("Task");
    expect(taskSessionToolNames(1, "off")).not.toContain("Task");
    expect(taskSessionToolNames(0, "prefer")).toContain("Task");
    expect(taskSessionToolNames(0)).toContain("Task");
    expect(taskSessionToolNames(1, "prefer")).not.toContain("Task");
  });
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "spcode-subagent-"));
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
    sessionId: "subagent-test",
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
  return { faux, create };
}

function assertPolicy(context: TranscriptContext, mode: SubagentMode) {
  const resolved = resolveTranscript(context, true);
  expect(getCurrentSystemPrompt(resolved.messages)).toContain(buildSubagentPolicy(mode));
  expect(resolved.messages.at(-1)?.role).not.toBe("system");
}

describe("SessionController 子代理三档集成", () => {
  it("off 创建摘除 Task 且注入禁用段；prefer/direct 保留 Task", async () => {
    const f = await fixture();
    const captured: TranscriptContext[] = [];
    f.faux.setResponses([
      (context) => {
        captured.push(structuredClone(context));
        return fauxAssistantMessage("ok");
      },
    ]);
    const off = await f.create({ sessionId: "sub-off", getSubagentMode: () => "off" });
    await off.prompt("hi");
    expect(getCurrentTools(captured[0]!.messages).map((t) => t.name)).not.toContain("Task");
    assertPolicy(captured[0]!, "off");

    const prefer = await f.create({ sessionId: "sub-prefer", getSubagentMode: () => "prefer" });
    expect(prefer.session.getActiveToolNames()).toContain("Task");
    const direct = await f.create({ sessionId: "sub-direct", getSubagentMode: () => "direct" });
    expect(direct.session.getActiveToolNames()).toContain("Task");
  }, 60000);

  it("setSubagentMode 热切换：下一请求工具集与策略段同步更新，且不写入历史", async () => {
    const f = await fixture();
    const captured: TranscriptContext[] = [];
    f.faux.setResponses(
      Array.from({ length: 3 }, () => (context: TranscriptContext) => {
        captured.push(structuredClone(context));
        return fauxAssistantMessage("ok");
      }),
    );
    // 模拟生产语义：宿主全局值可变（getter 读最新），setSubagentMode 同步刷新工具集
    let mode: SubagentMode = "prefer";
    const ctl = await f.create({ getSubagentMode: () => mode });
    await ctl.prompt("one");
    expect(getCurrentTools(captured[0]!.messages).map((t) => t.name)).toContain("Task");
    assertPolicy(captured[0]!, "prefer");

    mode = "off";
    ctl.setSubagentMode("off");
    await ctl.prompt("two");
    expect(getCurrentTools(captured[1]!.messages).map((t) => t.name)).not.toContain("Task");
    assertPolicy(captured[1]!, "off");

    mode = "direct";
    ctl.setSubagentMode("direct");
    await ctl.prompt("three");
    expect(getCurrentTools(captured[2]!.messages).map((t) => t.name)).toContain("Task");
    assertPolicy(captured[2]!, "direct");
    expect(JSON.stringify(ctl.history())).not.toContain(SUBAGENT_POLICY_SECTION);
  }, 60000);

  it("计划态热切换只更新存储列表；退出计划态按最新档位恢复", async () => {
    const f = await fixture();
    const ctl = await f.create({ getSubagentMode: () => "prefer" });
    await ctl.setPlanMode(true);
    ctl.setSubagentMode("off");
    expect(ctl.session.getActiveToolNames()).toContain("WritePlan");
    expect(ctl.session.getActiveToolNames()).not.toContain("Task");
    await ctl.setPlanMode(false);
    expect(ctl.session.getActiveToolNames()).not.toContain("Task");
    expect(ctl.session.getActiveToolNames()).not.toContain("WritePlan");
    ctl.setSubagentMode("prefer");
    expect(ctl.session.getActiveToolNames()).toContain("Task");
  }, 60000);
});
