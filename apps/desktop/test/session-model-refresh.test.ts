/**
 * 回归：设置页编辑模型（如系统消息角色改 system）后，已打开会话必须即时换用新模型对象。
 * 背景：千问兼容端点拒绝 developer 角色；会话创建时快照模型，目录刷新若不传播到活跃会话，
 * 旧快照会一直按自动探测结果发 developer 导致 400。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/agent-host/memory-store.js";
import {
  addCustomModel,
  addCustomProvider,
  createModelOverlayStore,
  removeCustomModel,
} from "../src/agent-host/model-overlay.js";
import { SessionController } from "../src/agent-host/session-controller.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const modelInput = {
  provider: "qwen-plan",
  modelId: "qwen-max",
  contextWindow: 131072,
  reasoning: true,
  vision: false,
};

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "spcode-model-refresh-"));
  dirs.push(dir);
  const agentDir = join(dir, "agent");
  const overlay = createModelOverlayStore(agentDir);
  addCustomProvider(overlay, {
    provider: "qwen-plan",
    name: "Qwen Token Plan",
    baseUrl: "https://token-plan.example.com/compatible-mode/v1",
    api: "openai-completions",
  });
  addCustomModel(overlay, modelInput);
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: overlay.managedPath,
    allowModelNetwork: false,
  });
  return { dir, agentDir, overlay, runtime };
}

function createController(
  agentDir: string,
  runtime: ModelRuntime,
  sessionId: string,
  modelRef?: { provider: string; modelId: string },
) {
  return SessionController.create({
    sessionId,
    cwd: join(agentDir, "..", "scratch"),
    agentDir,
    modelRuntime: runtime,
    memoryStore: new MemoryStore(join(agentDir, "..", "home")),
    mode: "chat",
    modelRef,
    emitEvent: () => {},
    emitUsage: () => {},
    emitTodo: () => {},
    emitPlanMode: () => {},
    emitPlan: () => {},
    requestPermission: async () => true,
    askQuestion: async () => ({}),
  });
}

function sessionEntries(ctl: SessionController): { type: string }[] {
  if (!ctl.sessionFile || !existsSync(ctl.sessionFile)) return [];
  return readFileSync(ctl.sessionFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string });
}

describe("活跃会话模型快照刷新", () => {
  it("系统消息角色改 system 后即时生效，且不写 model_change 记录", async () => {
    const { agentDir, overlay, runtime } = await setup();
    const ctl = await createController(agentDir, runtime, "s-role-edit", {
      provider: "qwen-plan",
      modelId: "qwen-max",
    });
    const before = ctl.session.model!;
    expect(before.provider).toBe("qwen-plan");
    expect(before.compat?.supportsDeveloperRole).toBeUndefined();

    addCustomModel(overlay, { ...modelInput, systemMessageRole: "system" });
    await runtime.refresh({ allowNetwork: false });
    ctl.refreshModelFromRegistry();

    const after = ctl.session.model!;
    expect(after).not.toBe(before);
    expect(after.id).toBe("qwen-max");
    expect(after.compat?.supportsDeveloperRole).toBe(false);
    expect(sessionEntries(ctl).some((e) => e.type === "model_change")).toBe(false);
    await ctl.dispose();
  }, 60000);

  it("模型从目录删除后刷新保持现状，不抛错也不清空会话模型", async () => {
    const { agentDir, overlay, runtime } = await setup();
    const ctl = await createController(agentDir, runtime, "s-model-removed", {
      provider: "qwen-plan",
      modelId: "qwen-max",
    });
    const before = ctl.session.model!;

    removeCustomModel(overlay, "qwen-plan", "qwen-max");
    await runtime.refresh({ allowNetwork: false });
    expect(() => ctl.refreshModelFromRegistry()).not.toThrow();
    expect(ctl.session.model).toBe(before);
    await ctl.dispose();
  }, 60000);

  it("无可用模型会话（unknown 占位）刷新为空操作", async () => {
    const { agentDir, runtime } = await setup();
    const ctl = await createController(agentDir, runtime, "s-no-model");
    const before = ctl.session.model;
    expect(before?.provider).toBe("unknown");
    expect(() => ctl.refreshModelFromRegistry()).not.toThrow();
    expect(ctl.session.model).toBe(before);
    await ctl.dispose();
  }, 60000);
});
