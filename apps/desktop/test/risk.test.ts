import { describe, expect, it } from "vitest";
import { classifyToolRisk } from "../src/agent-host/session-controller.js";

describe("classifyToolRisk", () => {
  it("只读工具放行", () => {
    expect(classifyToolRisk("read", { path: "/tmp/a" })).toBe("readonly");
    expect(classifyToolRisk("grep", { pattern: "x" })).toBe("readonly");
    expect(classifyToolRisk("ls", {})).toBe("readonly");
    expect(classifyToolRisk("find", {})).toBe("readonly");
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

  it("写文件类工具为 write", () => {
    expect(classifyToolRisk("write", { path: "a.ts", content: "" })).toBe("write");
    expect(classifyToolRisk("edit", { path: "a.ts" })).toBe("write");
  });
});
