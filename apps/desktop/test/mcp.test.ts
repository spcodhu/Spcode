/**
 * MCP 管理器测试（评审 R3-F3）：真实 stdio fixture 服务器（node 子进程，无网络）。
 * 覆盖：连接→工具枚举与命名→调用→错误透传→停用/变更断开。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpManager } from "../src/agent-host/mcp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "helpers", "mini-mcp-server.mjs");

describe("McpManager（真实 stdio fixture 服务器）", () => {
  it("连接后枚举工具（mcp__ 前缀命名）并可调用；isError 透传", async () => {
    const mgr = new McpManager();
    try {
      await mgr.syncServers({
        mini: { command: process.execPath, args: [FIXTURE] },
      });
      const tools = mgr.tools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(["mcp__mini__add", "mcp__mini__fail"]);

      const add = tools.find((t) => t.name === "mcp__mini__add")!;
      const r = (await add.execute("t1", { a: 2, b: 40 } as never, undefined, undefined, {} as never)) as {
        content: { text: string }[];
      };
      expect(r.content[0]?.text).toBe("42");

      const fail = tools.find((t) => t.name === "mcp__mini__fail")!;
      const rf = (await fail.execute("t2", {} as never, undefined, undefined, {} as never)) as {
        isError?: boolean;
      };
      expect(rf.isError).toBe(true);
    } finally {
      await mgr.disposeAll();
    }
  }, 30_000);

  it("停用/变更后工具表收缩；坏命令不影响其他服务器", async () => {
    const mgr = new McpManager();
    try {
      await mgr.syncServers({
        mini: { command: process.execPath, args: [FIXTURE] },
        broken: { command: join(__dirname, "helpers", "no-such-server.mjs") },
      });
      expect(mgr.tools().length).toBeGreaterThan(0); // broken 静默跳过
      expect(mgr.connectedServers()).toEqual(["mini"]);

      await mgr.syncServers({ mini: { command: process.execPath, args: [FIXTURE], enabled: false } });
      expect(mgr.tools()).toEqual([]);
      expect(mgr.connectedServers()).toEqual([]);
    } finally {
      await mgr.disposeAll();
    }
  }, 30_000);
});
