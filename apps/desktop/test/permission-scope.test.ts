/**
 * 授权作用域与撤销专项（AgentBridge 纯内存路径，不 fork 宿主）：
 * session 授权按主体隔离、project 授权由主进程落盘、撤销使待决与迟到回复失效。
 */
import type { PermissionRequest } from "@spcode/shared";
import { permissionScopes } from "@spcode/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentBridge } from "../src/main/agent-bridge.js";

function request(over: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: "r1",
    sessionId: "s1",
    toolName: "bash",
    args: { command: "pnpm test --run" },
    risk: "write",
    cwd: "/code/demo",
    ...over,
  };
}

function makeBridge() {
  const bridge = new AgentBridge({});
  const posted: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bridge as any).post = (cmd: unknown) => posted.push(cmd);
  return { bridge, posted };
}

describe("作用域推导", () => {
  it("危险/逃生舱仅 once；普通 shell 有 cwd 时可 session/project", () => {
    expect(permissionScopes(request({ risk: "danger" }))).toEqual(["once"]);
    expect(permissionScopes(request({ bypass: true }))).toEqual(["once"]);
    expect(permissionScopes(request())).toEqual(["once", "session", "project"]);
    expect(permissionScopes(request({ cwd: undefined }))).toEqual(["once", "session"]);
    expect(permissionScopes(request({ toolName: "network", args: { host: "x", port: 443 } }))).toEqual(["once"]);
  });
});

describe("会话级授权与撤销", () => {
  it("session 授权仅同主体免审；其他会话仍询问", () => {
    const { bridge, posted } = makeBridge();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bridge as any).adjudicate(request());
    expect(bridge.replyPermission("r1", true, "local", "session")).toBe(true);
    expect(posted).toContainEqual({ type: "permission.reply", payload: { requestId: "r1", approved: true } });

    // 同主体再次请求 → 会话规则命中，就地放行
    posted.length = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bridge as any).adjudicate(request({ requestId: "r2" }));
    expect(posted).toContainEqual({ type: "permission.reply", payload: { requestId: "r2", approved: true } });

    // 不同会话不共享会话级授权
    posted.length = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bridge as any).adjudicate(request({ requestId: "r3", sessionId: "s2" }));
    expect(posted).not.toContainEqual({ type: "permission.reply", payload: { requestId: "r3", approved: true } });
    expect(bridge.getPendingPermission("r3")).not.toBeNull();
  });

  it("撤销结清待决请求并使迟到回复失效；后续请求重新裁决", () => {
    const { bridge, posted } = makeBridge();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bridge as any).adjudicate(request());
    bridge.revokePermissions("s1");
    // 待决已被拒绝结清
    expect(posted).toContainEqual({ type: "permission.reply", payload: { requestId: "r1", approved: false } });
    expect(bridge.getPendingPermission("r1")).toBeNull();
    // 迟到回复无效
    expect(bridge.replyPermission("r1", true, "local", "once")).toBe(false);
    // 撤销后会话级授权清空：再次请求需重新裁决
    posted.length = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bridge as any).adjudicate(request({ requestId: "r4" }));
    expect(bridge.getPendingPermission("r4")).not.toBeNull();
  });

  it("不允许的 scope 被拒绝（danger 请求 project）", () => {
    const { bridge } = makeBridge();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bridge as any).adjudicate(request({ risk: "danger" }));
    expect(bridge.replyPermission("r1", true, "local", "project")).toBe(false);
    expect(bridge.getPendingPermission("r1")).not.toBeNull();
  });
});
