/**
 * 权限网关（permission-gate.ts）单测（评审 R3-C4）：
 * 计划模式门禁、文件路径守卫（deny/prompt）、风险分级、沙盒联动、逃生舱。
 * 全部纯函数式驱动（requestPermission 用桩），不起真实会话。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionRequest } from "@spcode/shared";
import { DEFAULT_SANDBOX_SETTINGS } from "@spcode/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBeforeToolCallGate } from "../src/agent-host/permission-gate.js";
import type { FsGuardPolicy } from "../src/agent-host/sandbox/fs-guard.js";

let root = "";
let cwd = "";
let spcodeHome = "";
let policy: FsGuardPolicy;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "spcode-gate-"));
  cwd = join(root, "project");
  spcodeHome = join(root, ".spcode");
  policy = { cwd, spcodeHome, extraDenyRead: [], extraAllowWrite: [] };
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

interface GateHarness {
  gate: ReturnType<typeof createBeforeToolCallGate>;
  requests: PermissionRequest[];
}

function makeGate(overrides?: {
  planMode?: boolean;
  sandboxState?: "active" | "disabled";
  sandboxSettings?: Partial<typeof DEFAULT_SANDBOX_SETTINGS>;
}): GateHarness {
  const requests: PermissionRequest[] = [];
  const gate = createBeforeToolCallGate({
    sessionId: "s-test",
    isPlanMode: () => overrides?.planMode === true,
    getFsPolicy: () => policy,
    getSandboxSettings: () => ({ ...DEFAULT_SANDBOX_SETTINGS, ...overrides?.sandboxSettings }),
    sandboxState: overrides?.sandboxState === "disabled" ? { state: "disabled" } : { state: "active" },
    requestPermission: async (req) => {
      requests.push(req);
      return req.args && typeof req.args === "object" && "__approve" in req.args;
    },
  });
  return { gate, requests };
}

describe("文件路径守卫", () => {
  it("凭据区读取：不弹窗直接 block（硬 deny）", async () => {
    const { gate, requests } = makeGate();
    const v = await gate({ toolCall: { name: "read", arguments: { path: "~/.ssh/id_ed25519" } } });
    expect(v?.block).toBe(true);
    expect(v?.reason).toContain("path policy");
    expect(requests).toHaveLength(0); // 硬 deny 不弹窗
  });

  it("~/.spcode 写入：danger 级弹窗；拒绝即 block，批准即放行", async () => {
    const { gate, requests } = makeGate();
    const v = await gate({
      toolCall: { name: "write", arguments: { path: join(spcodeHome, "MEMORY.md"), content: "x" } },
    });
    expect(v?.block).toBe(true); // 桩未带 __approve → 拒绝
    expect(requests[0]?.risk).toBe("danger");

    const v2 = await gate({
      toolCall: { name: "write", arguments: { path: join(spcodeHome, "MEMORY.md"), content: "x", __approve: true } },
    });
    expect(v2).toBeUndefined();
    expect(requests[1]?.risk).toBe("danger");
  });

  it("cwd 内 write 不触发路径弹窗（走正常风险流）", async () => {
    const { gate, requests } = makeGate();
    const v = await gate({ toolCall: { name: "write", arguments: { path: join(cwd, "a.ts"), content: "x" } } });
    expect(v?.block).toBe(true); // write 风险弹窗，桩拒绝
    expect(requests[0]?.risk).toBe("write"); // 是风险流而非路径守卫
  });
});

describe("计划模式门禁", () => {
  it("bash 白名单放行；写工具兜底拦截", async () => {
    const { gate, requests } = makeGate({ planMode: true });
    expect(await gate({ toolCall: { name: "bash", arguments: { command: "git status" } } })).toBeUndefined();
    const v = await gate({ toolCall: { name: "write", arguments: { path: "a.ts", content: "x" } } });
    expect(v?.block).toBe(true);
    expect(requests).toHaveLength(0);
  });
});

describe("沙盒联动", () => {
  it("沙盒内 write 级 + autoAllow → 静默放行；outward/danger 仍弹窗", async () => {
    const { gate, requests } = makeGate();
    expect(await gate({ toolCall: { name: "bash", arguments: { command: "mkdir out" } } })).toBeUndefined();
    expect(requests).toHaveLength(0);

    await gate({ toolCall: { name: "bash", arguments: { command: "git push origin main" } } });
    expect(requests.at(-1)?.risk).toBe("outward");
    await gate({ toolCall: { name: "bash", arguments: { command: "rm -rf /tmp/x" } } });
    expect(requests.at(-1)?.risk).toBe("danger");
  });

  it("沙盒关闭时 write 级 bash 弹窗（无 autoAllow 兜底）", async () => {
    const { gate, requests } = makeGate({ sandboxState: "disabled" });
    await gate({ toolCall: { name: "bash", arguments: { command: "mkdir out" } } });
    expect(requests).toHaveLength(1);
  });

  it("逃生舱：严格模式直接拒；开放时强制弹窗（bypass 标记）", async () => {
    const strict = makeGate({ sandboxSettings: { allowUnsandboxedCommands: false } });
    const v = await strict.gate({
      toolCall: { name: "bash", arguments: { command: "open .", dangerouslyDisableSandbox: true } },
    });
    expect(v?.block).toBe(true);
    expect(strict.requests).toHaveLength(0);

    const open = makeGate();
    await open.gate({ toolCall: { name: "bash", arguments: { command: "open .", dangerouslyDisableSandbox: true } } });
    expect(open.requests.at(-1)?.bypass).toBe(true);
    expect(open.requests.at(-1)?.sandboxed).toBe(false);
  });
});
