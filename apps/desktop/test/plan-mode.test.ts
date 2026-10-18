/**
 * 计划模式(Plan Mode)测试:
 * - bash 只读白名单判定
 * - WritePlan / ExitPlanMode 工具行为
 * - SessionController 计划态工具门禁与状态切换(集成)
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/agent-host/memory-store.js";
import { isPlanModeSafeCommand } from "../src/agent-host/plan-mode.js";
import { classifyToolRisk, SessionController } from "../src/agent-host/session-controller.js";
import { createExitPlanModeTool, EXIT_PLAN_QUESTION } from "../src/agent-host/tools/exit-plan-mode.js";
import { createWritePlanTool } from "../src/agent-host/tools/write-plan.js";

let dir = "";

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("isPlanModeSafeCommand:bash 只读白名单", () => {
  it("放行常见只读命令", () => {
    for (const cmd of [
      "ls -la",
      "cat package.json",
      "git status",
      "git log --oneline -20",
      "git diff HEAD~1",
      "git stash list",
      "git config --get user.name",
      "git config -l",
      "rg TODO src/",
      "find . -name '*.ts'",
      "cat a.txt | grep foo",
      "ls && pwd",
      "npm list",
      "pnpm outdated",
      "jq '.name' package.json",
    ]) {
      expect(isPlanModeSafeCommand(cmd), cmd).toBe(true);
    }
  });

  it("拦截写操作与危险命令", () => {
    for (const cmd of [
      "rm -rf node_modules",
      "git commit -m 'x'",
      "git push",
      "git stash pop",
      "git config user.name x",
      "npm install",
      "pnpm add lodash",
      "echo pwned > /tmp/x",
      "cat $(rm -rf /)",
      "cat `id`",
      "node -e 'console.log(1)'",
      "find . -delete",
      "sed -i '' s/a/b/ file",
      "touch newfile",
      "mkdir dir",
      // 白名单逃逸用例(评审 P0-2 回归):env 能执行任意程序,less/more 支持 !cmd 交互
      "env rm -rf /tmp/x",
      "env bash -c 'echo pwned'",
      "less /etc/passwd",
      "more ~/.spcode/MEMORY.md",
    ]) {
      expect(isPlanModeSafeCommand(cmd), cmd).toBe(false);
    }
  });

  it("读环境变量仍可用 printenv", () => {
    expect(isPlanModeSafeCommand("printenv PATH")).toBe(true);
  });

  it("评审 R3-C5 逃逸回归：换行分段/无空格重定向/git 写形态/find 写旗标/audit fix", () => {
    for (const cmd of [
      "cat a.txt\nrm -rf /tmp/x", // 换行不分段则首词 cat 放行整串
      "echo hi>x.md", // 无空格重定向
      "echo hi 2>/dev/null", // fd 重定向
      "echo hi &> log", // &> 重定向
      "git branch -D feature", // 强删分支
      "git branch new-feature", // 建分支（位置参数）
      "git tag v1.0", // 打标签
      "git tag -d v1.0", // 删标签
      "git remote add evil https://evil/x.git", // 写 remote
      "git remote set-url origin https://evil/x.git",
      "git config --unset user.name", // 写 config
      "find . -fprint out.txt", // find 写文件
      "find . -fprint0 out.txt",
      "npm audit fix", // 改 package-lock/node_modules
    ]) {
      expect(isPlanModeSafeCommand(cmd), cmd).toBe(false);
    }
  });

  it("评审 R3-C5 不误伤：git branch/tag/remote/config 的只读形态仍放行", () => {
    for (const cmd of [
      "git branch",
      "git branch -a",
      "git branch -v",
      "git branch --show-current",
      "git tag",
      "git tag -l",
      "git remote",
      "git remote -v",
      "git remote show origin",
      "git remote get-url origin",
      "git config --get user.name",
      "npm audit",
      "npm audit --json",
    ]) {
      expect(isPlanModeSafeCommand(cmd), cmd).toBe(true);
    }
  });
});

describe("classifyToolRisk:计划工具分级", () => {
  it("WritePlan / ExitPlanMode 归只读(不弹权限卡)", () => {
    expect(classifyToolRisk("WritePlan", { content: "x" })).toBe("readonly");
    expect(classifyToolRisk("ExitPlanMode", {})).toBe("readonly");
  });
});

describe("WritePlan 工具", () => {
  it("落盘计划文件并回调 onSaved,重复写覆盖", async () => {
    dir = dir || mkdtempSync(join(tmpdir(), "spcode-plan-"));
    const saved: string[] = [];
    const tool = createWritePlanTool({
      plansDir: join(dir, "plans"),
      sessionId: "s1",
      onSaved: (p) => saved.push(p),
    });
    const r1 = await tool.execute("t1", { content: "# 计划 v1" }, undefined as never);
    expect(r1.isError).toBeFalsy();
    const file = join(dir, "plans", "s1.md");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf-8")).toContain("# 计划 v1");
    expect(saved).toEqual([file]);

    await tool.execute("t2", { content: "# 计划 v2" }, undefined as never);
    expect(readFileSync(file, "utf-8")).toContain("# 计划 v2");
    expect(readFileSync(file, "utf-8")).not.toContain("v1");
    expect(saved).toHaveLength(2);
  });

  it("空内容报错不写盘", async () => {
    const tool = createWritePlanTool({ plansDir: join(dir, "plans2"), sessionId: "s2", onSaved: () => {} });
    const r = await tool.execute("t3", { content: "   " }, undefined as never);
    expect(r.isError).toBe(true);
  });
});

describe("ExitPlanMode 工具", () => {
  const makeTool = (answer: string | undefined, onApproved: () => Promise<void>) =>
    createExitPlanModeTool({
      sessionId: "s1",
      ask: async () => (answer === undefined ? {} : { [EXIT_PLAN_QUESTION]: answer }),
      isPlanMode: () => true,
      onApproved,
    });

  it("点「开始执行」→ 触发 onApproved,返回里要求先建 TodoWrite 清单", async () => {
    let approved = false;
    const tool = makeTool("开始执行", async () => {
      approved = true;
    });
    const r = await tool.execute("t1", {}, undefined as never);
    expect(approved).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("TodoWrite");
    expect(text).toContain("立即更新");
  });

  it("点「继续调整」→ 不批准,保持计划态", async () => {
    let approved = false;
    const tool = makeTool("继续调整", async () => {
      approved = true;
    });
    const r = await tool.execute("t2", {}, undefined as never);
    expect(approved).toBe(false);
    expect((r.content[0] as { text: string }).text).toContain("仍在计划模式");
  });

  it("跳过 → 不批准", async () => {
    let approved = false;
    const tool = makeTool(undefined, async () => {
      approved = true;
    });
    const r = await tool.execute("t3", {}, undefined as never);
    expect(approved).toBe(false);
    expect((r.content[0] as { text: string }).text).toContain("跳过");
  });

  it("非计划态调用 → 直接报错", async () => {
    const tool = createExitPlanModeTool({
      sessionId: "s1",
      ask: async () => ({}),
      isPlanMode: () => false,
      onApproved: async () => {},
    });
    const r = await tool.execute("t4", {}, undefined as never);
    expect(r.isError).toBe(true);
  });
});

describe("SessionController 计划模式集成", () => {
  const createCtl = async (planMode?: boolean) => {
    const rt = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      allowModelNetwork: false,
    });
    const store = new MemoryStore(join(dir, "home"));
    return SessionController.create({
      sessionId: planMode ? "plan-on" : "plan-off",
      cwd: join(dir, "scratch"),
      agentDir: join(dir, "agent"),
      modelRuntime: rt,
      memoryStore: store,
      mode: "chat",
      planMode,
      emitEvent: () => {},
      emitUsage: () => {},
      emitTodo: () => {},
      emitPlanMode: () => {},
      emitPlan: () => {},
      requestPermission: async () => true,
      askQuestion: async () => ({}),
    });
  };

  // beforeToolCall 的运行时形状与 SessionController 里挂的钩子一致
  const gate = (ctl: SessionController, name: string, args: unknown) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctl.session.agent as any).beforeToolCall({ toolCall: { name, arguments: args } }) as Promise<
      undefined | { block: boolean; reason?: string }
    >;

  it("正常态:WritePlan/ExitPlanMode 不在工具列表,写工具在", async () => {
    dir = dir || mkdtempSync(join(tmpdir(), "spcode-plan-"));
    const ctl = await createCtl();
    const tools = ctl.session.getActiveToolNames();
    expect(tools).not.toContain("WritePlan");
    expect(tools).not.toContain("ExitPlanMode");
    for (const expected of ["read", "bash", "edit", "write", "TodoWrite", "Task"]) {
      expect(tools, `正常态缺少 ${expected}`).toContain(expected);
    }
    expect(ctl.info().planMode).toBe(false);
    await ctl.dispose();
  }, 60000);

  it("planMode:true 创建 → 计划工具集;门禁拦写放行只读;setPlanMode 往返恢复", async () => {
    const ctl = await createCtl(true);
    const tools = ctl.session.getActiveToolNames();
    for (const expected of ["read", "bash", "grep", "find", "ls", "AskUserQuestion", "WritePlan", "ExitPlanMode"]) {
      expect(tools, `计划态缺少 ${expected}`).toContain(expected);
    }
    for (const removed of ["edit", "write", "Task", "TodoWrite"]) {
      expect(tools, `计划态应摘掉 ${removed}`).not.toContain(removed);
    }
    expect(ctl.info().planMode).toBe(true);

    // 门禁:写工具兜底拦截(带引导文案),bash 白名单放行/拦截,WritePlan 放行
    expect((await gate(ctl, "edit", { path: "a" }))?.block).toBe(true);
    expect((await gate(ctl, "edit", { path: "a" }))?.reason).toContain("ExitPlanMode");
    expect(await gate(ctl, "bash", { command: "ls -la" })).toBeUndefined();
    expect((await gate(ctl, "bash", { command: "npm install" }))?.block).toBe(true);
    expect((await gate(ctl, "bash", { command: "rm -rf /" }))?.block).toBe(true);
    expect(await gate(ctl, "WritePlan", { content: "x" })).toBeUndefined();
    expect(await gate(ctl, "AskUserQuestion", { questions: [] })).toBeUndefined();

    // 批准后退计划态:工具集恢复,门禁回到权限流程(mock 全批 → 全放行)
    await ctl.setPlanMode(false);
    const restored = ctl.session.getActiveToolNames();
    for (const expected of ["edit", "write", "TodoWrite", "Task"]) {
      expect(restored, `恢复后缺少 ${expected}`).toContain(expected);
    }
    expect(restored).not.toContain("WritePlan");
    expect(ctl.info().planMode).toBe(false);
    expect(await gate(ctl, "edit", { path: "a" })).toBeUndefined();

    // 再进计划态,幂等
    await ctl.setPlanMode(true);
    expect(ctl.session.getActiveToolNames()).toContain("WritePlan");
    expect((await gate(ctl, "write", { path: "a" }))?.block).toBe(true);

    await ctl.dispose();
  }, 60000);
});
