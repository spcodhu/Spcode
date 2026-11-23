import { createReportWorkTool } from "@spcode/agent-runtime/tools/report-work.js";
import { workerShellAllowed, workerToolViolation } from "@spcode/agent-runtime/worker-policy.js";
import { describe, expect, it, vi } from "vitest";

describe("SuperAgent Worker Git 白名单", () => {
  it.each(["git status --short", "git -C /repo diff --stat", "pnpm test && git diff --check", "/usr/bin/git log -1"])(
    "允许明确只读命令：%s",
    (command) => expect(workerShellAllowed(command)).toBe(true),
  );

  it.each([
    "git add .",
    "git commit -m test",
    "git checkout -b worker",
    "git reset --hard HEAD",
    "git stash push",
    "git branch worker",
    "git config user.name bot",
    "pnpm test; git push origin worker",
    "sh -c 'git add .'",
    "git -c core.pager=rm log",
  ])("硬拒绝 Git 写或无法证明只读：%s", (command) => expect(workerShellAllowed(command)).toBe(false));

  it("Task、MCP、标题与生图不进入 Worker 权限绕过", () => {
    expect(workerToolViolation("Task", {})).toMatch(/disabled/);
    expect(workerToolViolation("mcp__server__deploy", {})).toMatch(/disabled/);
    expect(workerToolViolation("RenameSession", {})).toMatch(/disabled/);
    expect(workerToolViolation("bash", { command: "git diff" })).toBeNull();
  });
});

describe("ReportWork 结构化结果", () => {
  it("原样上抛测试证据与建议 commit，不执行 Git", async () => {
    const onReport = vi.fn();
    const tool = createReportWorkTool(onReport);
    const result = await tool.execute(
      "report",
      {
        status: "ready",
        summary: "已完成修改",
        tests: [{ command: "pnpm test", status: "passed", exitCode: 0, durationMs: 12 }],
        commitMessage: "功能: 完成任务",
      },
      undefined as never,
    );
    expect(result.isError).not.toBe(true);
    expect(onReport).toHaveBeenCalledWith({
      status: "ready",
      summary: "已完成修改",
      tests: [{ command: "pnpm test", status: "passed", exitCode: 0, durationMs: 12 }],
      commitMessage: "功能: 完成任务",
    });
  });

  it("空摘要不上报", async () => {
    const onReport = vi.fn();
    const tool = createReportWorkTool(onReport);
    const result = await tool.execute("report", { status: "ready", summary: " ", tests: [] }, undefined as never);
    expect(result.isError).toBe(true);
    expect(onReport).not.toHaveBeenCalled();
  });
});
