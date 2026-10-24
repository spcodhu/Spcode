/**
 * 网络域名询问的会话归因判定（纯函数单测）：
 * 代理是进程级单例、拿不到会话，只能按「当前在跑命令的会话」推断要不要打扰用户。
 *
 * 不变量：
 * - 全部 inflight 会话都是「总不询问」→ 静默放行；
 * - 空集合（无法归因）、含任一非 never、含未知会话 → 一律问（保守方向）。
 */

import { describe, expect, it } from "vitest";
import { shouldAllowNetworkSilently } from "../src/agent-host/sandbox/manager.js";

describe("shouldAllowNetworkSilently", () => {
  const resolve = (modes: Record<string, "ask" | "auto" | "never">) => (id: string) => modes[id] ?? null;

  it("全部 never → 静默放行", () => {
    expect(shouldAllowNetworkSilently(["a", "b"], resolve({ a: "never", b: "never" }))).toBe(true);
  });

  it("含 ask / auto → 需要问", () => {
    expect(shouldAllowNetworkSilently(["a", "b"], resolve({ a: "never", b: "auto" }))).toBe(false);
    expect(shouldAllowNetworkSilently(["a"], resolve({ a: "ask" }))).toBe(false);
  });

  it("无法归因（空集合/未知会话）→ 需要问", () => {
    expect(shouldAllowNetworkSilently([], resolve({ a: "never" }))).toBe(false);
    expect(shouldAllowNetworkSilently(["ghost"], resolve({ a: "never" }))).toBe(false);
  });

  it("同一会话重复出现不影响结果", () => {
    expect(shouldAllowNetworkSilently(["a", "a"], resolve({ a: "never" }))).toBe(true);
  });
});
