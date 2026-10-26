import { describe, expect, it } from "vitest";
import { formatSandboxViolations } from "../src/agent-host/sandbox/bash-tool.js";

describe("formatSandboxViolations", () => {
  it("过滤无害系统探测，保留文件与网络边界拒绝", () => {
    const output = formatSandboxViolations([
      { line: "node(1) deny(1) sysctl-read kern.iossupportversion" },
      { line: "git(2) deny(1) system-info vfs.disk-space" },
      { line: "node(3) deny(1) mach-lookup com.apple.SystemConfiguration.DNSConfiguration" },
      { line: "node(4) deny(1) file-write-create /work/node_modules/pkg/.idea/settings.xml" },
      { line: "curl(5) deny(1) network-outbound 203.0.113.10:443" },
    ]);
    expect(output).not.toContain("sysctl-read");
    expect(output).not.toContain("vfs.disk-space");
    expect(output).not.toContain("SystemConfiguration");
    expect(output).toContain("file-write-create");
    expect(output).toContain("network-outbound");
    expect(output).toContain("(3 environment-only records omitted)");
  });

  it("只有环境噪音时不再输出违规块", () => {
    expect(formatSandboxViolations([{ line: "node(1) deny(1) sysctl-read kern.iossupportversion" }])).toBe("");
  });

  it("真实违规超过五条时截断并保留计数", () => {
    const output = formatSandboxViolations(
      Array.from({ length: 7 }, (_, i) => ({ line: `node(${i}) deny(1) file-write-create /work/${i}` })),
    );
    expect(output).toContain("/work/4");
    expect(output).not.toContain("/work/5");
    expect(output).toContain("... 2 more restrictions in diagnostic log");
  });
});
