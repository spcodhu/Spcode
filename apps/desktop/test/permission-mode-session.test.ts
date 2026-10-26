/**
 * SessionController 权限模式集成测试（不起真实模型，只验证状态与门禁接线）：
 * - 创建时带 permissionMode → info() 回报、门禁按该档裁决
 * - 缺省档位 = 总是询问（写操作必须走权限请求）
 * - setPermissionMode 热切换 → 门禁立即按新档裁决、上抛 session.permissionmode 事件
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PermissionMode, PermissionRequest } from "@spcode/shared";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/agent-host/memory-store.js";
import { SessionController } from "../src/agent-host/session-controller.js";

const dir = mkdtempSync(join(tmpdir(), "spcode-permmode-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function createCtl(opts: { sessionId: string; permissionMode?: PermissionMode }) {
  const rt = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    allowModelNetwork: false,
  });
  const requests: PermissionRequest[] = [];
  const emitted: PermissionMode[] = [];
  const ctl = await SessionController.create({
    sessionId: opts.sessionId,
    cwd: join(dir, "scratch"),
    agentDir: join(dir, "agent"),
    modelRuntime: rt,
    memoryStore: new MemoryStore(join(dir, "home")),
    mode: "chat",
    permissionMode: opts.permissionMode,
    emitEvent: () => {},
    emitUsage: () => {},
    emitTodo: () => {},
    emitPlanMode: () => {},
    emitPlan: () => {},
    emitPermissionMode: (mode) => emitted.push(mode),
    requestPermission: async (req) => {
      requests.push(req);
      return false; // 默认拒绝，便于区分「有没有弹窗」
    },
    askQuestion: async () => ({}),
  });
  // beforeToolCall 的运行时形状与 SessionController 里挂的钩子一致
  const gate = (name: string, args: unknown) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctl.session.agent as any).beforeToolCall({ toolCall: { name, arguments: args } }) as Promise<
      undefined | { block: boolean; reason?: string }
    >;
  return { ctl, gate, requests, emitted };
}

describe("SessionController 权限模式", () => {
  it("缺省档位 = 总是询问：写操作必须走权限请求", async () => {
    const { ctl, gate, requests } = await createCtl({ sessionId: "pm-default" });
    expect(ctl.info().permissionMode).toBe("ask");
    const verdict = await gate("write", { path: join(dir, "scratch", "a.txt"), content: "x" });
    expect(verdict?.block).toBe(true); // 桩拒绝
    expect(requests).toHaveLength(1);
    expect(requests[0]?.risk).toBe("write");
    await ctl.dispose();
  }, 60_000);

  it("必要时询问：写操作直接放行，不产生权限请求", async () => {
    const { ctl, gate, requests } = await createCtl({ sessionId: "pm-auto", permissionMode: "auto" });
    expect(ctl.info().permissionMode).toBe("auto");
    expect(await gate("write", { path: join(dir, "scratch", "b.txt"), content: "x" })).toBeUndefined();
    expect(requests).toHaveLength(0);
    await ctl.dispose();
  }, 60_000);

  it("setPermissionMode 热切换：门禁立即跟随，并上抛事件", async () => {
    const { ctl, gate, requests, emitted } = await createCtl({ sessionId: "pm-switch" });
    expect(await gate("write", { path: join(dir, "scratch", "c.txt"), content: "x" })).toBeDefined();

    await ctl.setPermissionMode("never");
    expect(ctl.info().permissionMode).toBe("never");
    expect(ctl.currentPermissionMode).toBe("never");
    expect(emitted).toEqual(["never"]);
    expect(await gate("write", { path: join(dir, "scratch", "d.txt"), content: "x" })).toBeUndefined();
    expect(requests).toHaveLength(1); // 只有切换前那一次

    // 幂等：重复设同一档不再上抛
    await ctl.setPermissionMode("never");
    expect(emitted).toEqual(["never"]);
    await ctl.dispose();
  }, 60_000);

  it.skipIf(process.platform === "win32")("非 Windows 不注册 PowerShell", async () => {
    const { ctl } = await createCtl({ sessionId: "pm-platform-tools" });
    expect(ctl.session.agent.state.tools.some((tool) => tool.name === "powershell")).toBe(false);
    await ctl.dispose();
  }, 60_000);
});
