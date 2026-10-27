/**
 * 权限网关（permission-gate.ts）单测（评审 R3-C4）：
 * 计划模式门禁、文件路径守卫（deny/prompt）、风险分级、沙盒联动、逃生舱。
 * 全部纯函数式驱动（requestPermission 用桩），不起真实会话。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionMode, PermissionRequest } from "@spcode/shared";
import { DEFAULT_SANDBOX_SETTINGS } from "@spcode/shared";
import { renderMessage, setLocale } from "@spcode/shared/i18n";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createBeforeToolCallGate } from "../src/agent-host/permission-gate.js";
import type { FsGuardPolicy } from "../src/agent-host/sandbox/fs-guard.js";

afterEach(() => setLocale("zh-CN"));

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
  permissionMode?: PermissionMode;
}): GateHarness {
  const requests: PermissionRequest[] = [];
  const gate = createBeforeToolCallGate({
    sessionId: "s-test",
    isPlanMode: () => overrides?.planMode === true,
    getPermissionMode: () => overrides?.permissionMode ?? "ask",
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

describe("拦下原因的可本地化文案", () => {
  it("严格模式与用户拒绝都带 canonical reason + reasonMessage", async () => {
    setLocale("zh-CN");
    const strict = makeGate({ sandboxSettings: { allowUnsandboxedCommands: false } });
    const blocked = await strict.gate({
      toolCall: { name: "bash", arguments: { command: "open .", dangerouslyDisableSandbox: true } },
    });
    expect(blocked?.reason).toContain("Sandbox strict mode");
    expect(blocked?.reasonMessage?.key).toBe("main:permission.sandboxStrict");
    expect(renderMessage(blocked!.reasonMessage!)).toContain("沙盒严格模式");
    setLocale("en");
    expect(renderMessage(blocked!.reasonMessage!)).toBe(blocked?.reason);
    expect(strict.requests).toHaveLength(0);

    const denied = await makeGate().gate({
      toolCall: { name: "bash", arguments: { command: "git push origin main" } },
    });
    expect(denied?.reasonMessage?.key).toBe("main:permission.denied");
    expect(renderMessage(denied!.reasonMessage!)).toBe(denied?.reason);
  });
});

describe("权限模式矩阵（宿主侧）", () => {
  it("总是询问：沙盒内的 write 也必须弹窗（回归：autoAllow 时代的静默放行）", async () => {
    const { gate, requests } = makeGate({ permissionMode: "ask" });
    await gate({ toolCall: { name: "bash", arguments: { command: "mkdir out" } } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.risk).toBe("write");
    expect(requests[0]?.sandboxed).toBe(true);

    await gate({ toolCall: { name: "edit", arguments: { path: join(cwd, "a.ts"), oldText: "a", newText: "b" } } });
    expect(requests.at(-1)?.risk).toBe("write");
  });

  it("必要时询问：write 不弹窗、对外/危险仍弹窗", async () => {
    const { gate, requests } = makeGate({ permissionMode: "auto" });
    expect(await gate({ toolCall: { name: "bash", arguments: { command: "mkdir out" } } })).toBeUndefined();
    expect(requests).toHaveLength(0);

    await gate({ toolCall: { name: "bash", arguments: { command: "git push origin main" } } });
    expect(requests.at(-1)?.risk).toBe("outward");
    expect(requests.at(-1)?.cwd).toBe(cwd);
    await gate({ toolCall: { name: "bash", arguments: { command: "rm -rf /tmp/x" } } });
    expect(requests.at(-1)?.risk).toBe("danger");
  });

  it("必要时询问 + 沙盒关闭：写类仍免问（沿用 act 语义，界面另有警示）", async () => {
    const { gate, requests } = makeGate({ permissionMode: "auto", sandboxState: "disabled" });
    expect(await gate({ toolCall: { name: "bash", arguments: { command: "mkdir out" } } })).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("总不询问：对外/危险/写全部免问，但逃生舱仍要问、凭据区仍硬拒", async () => {
    const { gate, requests } = makeGate({ permissionMode: "never" });
    expect(await gate({ toolCall: { name: "bash", arguments: { command: "git push origin main" } } })).toBeUndefined();
    expect(await gate({ toolCall: { name: "bash", arguments: { command: "rm -rf /tmp/x" } } })).toBeUndefined();
    expect(await gate({ toolCall: { name: "bash", arguments: { command: "mkdir out" } } })).toBeUndefined();
    expect(requests).toHaveLength(0);

    // 逃生舱是三档共用的唯一人工确认点
    await gate({ toolCall: { name: "bash", arguments: { command: "open .", dangerouslyDisableSandbox: true } } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.bypass).toBe(true);

    // 凭据区是硬闸，任何档位都不放开
    const deny = await gate({ toolCall: { name: "read", arguments: { path: "~/.ssh/id_ed25519" } } });
    expect(deny?.block).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("总不询问：写 ~/.spcode 的路径弹窗（danger）也被自动放行", async () => {
    const { gate, requests } = makeGate({ permissionMode: "never" });
    const v = await gate({
      toolCall: { name: "write", arguments: { path: join(spcodeHome, "MEMORY.md"), content: "x" } },
    });
    expect(v).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("计划模式门禁在总不询问档下仍然硬拦", async () => {
    const { gate, requests } = makeGate({ permissionMode: "never", planMode: true });
    const v = await gate({ toolCall: { name: "bash", arguments: { command: "npm install" } } });
    expect(v?.block).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("逃生舱：严格模式直接拒；开放时三档都强制弹窗（bypass 标记）", async () => {
    const strict = makeGate({ sandboxSettings: { allowUnsandboxedCommands: false } });
    const v = await strict.gate({
      toolCall: { name: "bash", arguments: { command: "open .", dangerouslyDisableSandbox: true } },
    });
    expect(v?.block).toBe(true);
    expect(strict.requests).toHaveLength(0);

    for (const mode of ["ask", "auto", "never"] as const) {
      const open = makeGate({ permissionMode: mode });
      await open.gate({
        toolCall: { name: "bash", arguments: { command: "open .", dangerouslyDisableSandbox: true } },
      });
      expect(open.requests, mode).toHaveLength(1);
      expect(open.requests[0]?.bypass).toBe(true);
      expect(open.requests.at(-1)?.sandboxed).toBe(false);
    }
  });
});
