/**
 * GenerateImage 工具集门控集成测试（fauxProvider，不触网）：
 * - 创建时按配置完整性决定是否进活跃工具集（未配置时模型看不到它）
 * - setImageGenReady 热插拔：活跃会话即时增删，幂等
 * - 计划态排除生图；退出计划态按最新配置恢复
 * - setSubagentMode 重建工具集不误伤生图技能
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ImageGenConfig } from "@spcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/agent-host/memory-store.js";
import { SessionController, type SessionControllerOptions } from "../src/agent-host/session-controller.js";

const READY: ImageGenConfig = {
  protocol: "openai-images",
  baseUrl: "https://api.example.com/v1/images/generations",
  apiKey: "sk-test",
  model: "gpt-image-1",
};

const dirs: string[] = [];
const controllers: SessionController[] = [];
afterEach(async () => {
  for (const ctl of controllers.splice(0)) await ctl.dispose();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "spcode-image-gate-"));
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
    sessionId: "image-gate-test",
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
  return { create };
}

describe("GenerateImage 工具集门控", () => {
  it("创建时：未配置不进活跃工具集，配置完整才进", async () => {
    const f = await fixture();
    const unconfigured = await f.create({ sessionId: "img-off" });
    expect(unconfigured.session.getActiveToolNames()).not.toContain("GenerateImage");
    const configured = await f.create({ sessionId: "img-on", getImageGenConfig: () => READY });
    expect(configured.session.getActiveToolNames()).toContain("GenerateImage");
    // 空字段配置同样不生效（fail-safe）
    const empty = await f.create({ sessionId: "img-empty", getImageGenConfig: () => ({ ...READY, apiKey: "" }) });
    expect(empty.session.getActiveToolNames()).not.toContain("GenerateImage");
  }, 60000);

  it("setImageGenReady 热插拔：即时增删且幂等", async () => {
    const f = await fixture();
    const ctl = await f.create();
    expect(ctl.session.getActiveToolNames()).not.toContain("GenerateImage");
    ctl.setImageGenReady(true);
    expect(ctl.session.getActiveToolNames()).toContain("GenerateImage");
    ctl.setImageGenReady(true);
    expect(ctl.session.getActiveToolNames().filter((n) => n === "GenerateImage")).toHaveLength(1);
    ctl.setImageGenReady(false);
    expect(ctl.session.getActiveToolNames()).not.toContain("GenerateImage");
    ctl.setImageGenReady(false);
    expect(ctl.session.getActiveToolNames()).not.toContain("GenerateImage");
  }, 60000);

  it("计划态排除生图；退出计划态按最新配置恢复", async () => {
    const f = await fixture();
    const ctl = await f.create({ getImageGenConfig: () => READY });
    await ctl.setPlanMode(true);
    expect(ctl.session.getActiveToolNames()).toContain("WritePlan");
    expect(ctl.session.getActiveToolNames()).not.toContain("GenerateImage");
    // 计划态期间配置被清空：只更新存储列表，退出后不恢复
    ctl.setImageGenReady(false);
    await ctl.setPlanMode(false);
    expect(ctl.session.getActiveToolNames()).not.toContain("GenerateImage");
    ctl.setImageGenReady(true);
    expect(ctl.session.getActiveToolNames()).toContain("GenerateImage");
  }, 60000);

  it("setSubagentMode 重建工具集不误伤生图技能", async () => {
    const f = await fixture();
    const ctl = await f.create({ getImageGenConfig: () => READY });
    ctl.setSubagentMode("off");
    expect(ctl.session.getActiveToolNames()).not.toContain("Task");
    expect(ctl.session.getActiveToolNames()).toContain("GenerateImage");
    ctl.setSubagentMode("prefer");
    expect(ctl.session.getActiveToolNames()).toContain("Task");
    expect(ctl.session.getActiveToolNames()).toContain("GenerateImage");
  }, 60000);
});
