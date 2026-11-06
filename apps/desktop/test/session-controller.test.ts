/**
 * SessionController 集成测试：完整走一遍会话创建 + 自研工具注册 + 记忆注入。
 * 这是 E2E 发现"新建聊天无响应"后补的回归测试。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/agent-host/memory-store.js";
import { SessionController } from "../src/agent-host/session-controller.js";
import { taskSessionToolNames } from "../src/agent-host/tools/task.js";

let dir = "";

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("SessionController 集成", () => {
  it("无凭证也能创建会话（模型 unknown），自研工具与记忆注入不炸", async () => {
    dir = mkdtempSync(join(tmpdir(), "spcode-ctl-"));
    const rt = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      allowModelNetwork: false,
    });
    const store = new MemoryStore(join(dir, "home"));
    const ctl = await SessionController.create({
      sessionId: "test-session",
      cwd: join(dir, "scratch"),
      agentDir: join(dir, "agent"),
      modelRuntime: rt,
      memoryStore: store,
      mode: "chat",
      emitEvent: () => {},
      emitUsage: () => {},
      emitTodo: () => {},
      emitPlanMode: () => {},
      emitPlan: () => {},
      requestPermission: async () => true,
      askQuestion: async () => ({}),
    });
    const info = ctl.info();
    expect(info.sessionId).toBe("test-session");
    expect(ctl.sessionFile).toBeTruthy();

    // 自研工具已注册进活动工具集
    const toolNames = ctl.session.getActiveToolNames();
    for (const expected of [
      "grep",
      "find",
      "ls",
      "WebSearch",
      "WebFetch",
      "TodoWrite",
      "AskUserQuestion",
      "RenameSession",
      "Task",
    ]) {
      expect(toolNames, `缺少工具 ${expected}`).toContain(expected);
    }

    // 系统提示里应有记忆块（SOUL 播种内容）与标题约定
    expect(ctl.session.systemPrompt).toContain("Spcod Memory");
    expect(ctl.session.systemPrompt).toContain("Session title convention");

    await ctl.dispose();
  }, 60000);

  it("MCP 工具在正常模式激活、计划模式摘除、退出后恢复", async () => {
    const rt = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      allowModelNetwork: false,
    });
    const mcpTool: ToolDefinition = {
      name: "mcp__mini__add",
      label: "mini: add",
      description: "Add two numbers",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    const ctl = await SessionController.create({
      sessionId: "test-mcp-activation",
      cwd: join(dir, "scratch"),
      agentDir: join(dir, "agent"),
      modelRuntime: rt,
      memoryStore: new MemoryStore(join(dir, "home")),
      mode: "chat",
      getMcpTools: () => [mcpTool],
      emitEvent: () => {},
      emitUsage: () => {},
      emitTodo: () => {},
      emitPlanMode: () => {},
      emitPlan: () => {},
      requestPermission: async () => true,
      askQuestion: async () => ({}),
    });

    expect(ctl.session.getActiveToolNames()).toContain("mcp__mini__add");
    await ctl.setPlanMode(true);
    expect(ctl.session.getActiveToolNames()).not.toContain("mcp__mini__add");
    await ctl.setPlanMode(false);
    expect(ctl.session.getActiveToolNames()).toContain("mcp__mini__add");
    await ctl.dispose();
  }, 60000);

  it("noTitleAutomation：不注入标题约定（定时任务会话用）", async () => {
    const rt = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      allowModelNetwork: false,
    });
    const store = new MemoryStore(join(dir, "home"));
    const ctl = await SessionController.create({
      sessionId: "test-scheduled",
      cwd: join(dir, "scratch"),
      agentDir: join(dir, "agent"),
      modelRuntime: rt,
      memoryStore: store,
      mode: "chat",
      noTitleAutomation: true,
      emitEvent: () => {},
      emitUsage: () => {},
      emitTodo: () => {},
      emitPlanMode: () => {},
      emitPlan: () => {},
      requestPermission: async () => true,
      askQuestion: async () => ({}),
    });
    expect(ctl.session.systemPrompt).not.toContain("Session title convention");
    await ctl.dispose();
  }, 60000);
});

describe("Task 子代理工具面", () => {
  it("启用基础检索工具，并按深度限制嵌套 Task", () => {
    for (const name of ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]) {
      expect(taskSessionToolNames(0)).toContain(name);
      expect(taskSessionToolNames(1)).toContain(name);
      expect(taskSessionToolNames(2)).toContain(name);
    }
    expect(taskSessionToolNames(0)).toContain("Task");
    expect(taskSessionToolNames(1)).not.toContain("Task");
    expect(taskSessionToolNames(2)).not.toContain("Task");
    expect(taskSessionToolNames(0)).not.toContain("TodoWrite");
    expect(taskSessionToolNames(0).some((name) => name.startsWith("mcp__"))).toBe(false);
  });
});
