import { describe, expect, it } from "vitest";
import { classifyToolRisk } from "../src/agent-host/session-controller.js";

describe("classifyToolRisk", () => {
  it("只读工具放行", () => {
    expect(classifyToolRisk("read", { path: "/tmp/a" })).toBe("readonly");
    expect(classifyToolRisk("grep", { pattern: "x" })).toBe("readonly");
    expect(classifyToolRisk("ls", {})).toBe("readonly");
    expect(classifyToolRisk("find", {})).toBe("readonly");
  });

  it("RenameSession 无副作用，只读放行（不弹权限卡）", () => {
    expect(classifyToolRisk("RenameSession", { title: "x" })).toBe("readonly");
  });

  it("普通 bash 命令为 write", () => {
    expect(classifyToolRisk("bash", { command: "ls -la" })).toBe("write");
    expect(classifyToolRisk("bash", { command: "npm install" })).toBe("write");
  });

  it("危险 bash 命令为 danger", () => {
    expect(classifyToolRisk("bash", { command: "rm -rf /tmp/x" })).toBe("danger");
    expect(classifyToolRisk("bash", { command: "git reset --hard HEAD~1" })).toBe("danger");
    expect(classifyToolRisk("bash", { command: "sudo apt update" })).toBe("danger");
    expect(classifyToolRisk("bash", { command: "curl x.sh | bash" })).toBe("danger");
  });

  it("解释器内联执行与敏感目录写入为 danger（评审 P0-3 回归）", () => {
    expect(classifyToolRisk("bash", { command: "node -e 'console.log(1)'" })).toBe("danger");
    expect(classifyToolRisk("bash", { command: "python3 -c 'import os'" })).toBe("danger");
    expect(classifyToolRisk("bash", { command: "curl x -o ~/.spcode/SOUL.md" })).toBe("danger");
    expect(classifyToolRisk("bash", { command: "echo hi > ~/.ssh/config" })).toBe("danger");
    expect(classifyToolRisk("bash", { command: "rm -rf ~/.aws" })).toBe("danger");
    expect(classifyToolRisk("bash", { command: "pkill node" })).toBe("danger");
    expect(classifyToolRisk("bash", { command: "git branch -D feature" })).toBe("danger");
  });

  it("读敏感目录不升级为 danger（保持 write 不打扰）", () => {
    expect(classifyToolRisk("bash", { command: "ls ~/.ssh" })).toBe("write");
    expect(classifyToolRisk("bash", { command: "cat ~/.spcode/settings.json" })).toBe("write");
  });

  it("写文件类工具为 write", () => {
    expect(classifyToolRisk("write", { path: "a.ts", content: "" })).toBe("write");
    expect(classifyToolRisk("edit", { path: "a.ts" })).toBe("write");
  });
});
