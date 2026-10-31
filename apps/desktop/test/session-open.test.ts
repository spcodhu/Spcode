import { describe, expect, it, vi } from "vitest";
import { getOrCreateOpenedController } from "../src/agent-host/session-open.js";

describe("session.open 活跃实例复用", () => {
  it("运行中重复打开：不重建、不 dispose，保留同一个 controller", async () => {
    const controller = { id: "running", running: true, dispose: vi.fn(async () => {}) };
    const sessions = new Map([[controller.id, controller]]);
    const create = vi.fn(async () => ({ id: "replacement", running: false, dispose: vi.fn(async () => {}) }));

    const first = await getOrCreateOpenedController(sessions, controller.id, create);
    const second = await getOrCreateOpenedController(sessions, controller.id, create);

    expect(first).toEqual({ controller, reused: true });
    expect(second).toEqual({ controller, reused: true });
    expect(sessions.get(controller.id)).toBe(controller);
    expect(create).not.toHaveBeenCalled();
    expect(controller.dispose).not.toHaveBeenCalled();
  });

  it("仅在宿主没有活跃实例时创建；后续打开转为复用", async () => {
    const sessions = new Map<string, { id: string; dispose: ReturnType<typeof vi.fn> }>();
    const controller = { id: "cold", dispose: vi.fn(async () => {}) };
    const create = vi.fn(async () => controller);

    const cold = await getOrCreateOpenedController(sessions, "cold", create);
    const reopened = await getOrCreateOpenedController(sessions, "cold", create);

    expect(cold).toEqual({ controller, reused: false });
    expect(reopened).toEqual({ controller, reused: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(controller.dispose).not.toHaveBeenCalled();
  });
});
