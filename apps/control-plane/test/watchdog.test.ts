import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteSuperAgentStore } from "../src/store-sqlite.js";
import { type WatchdogHealth, WatchdogMonitor } from "../src/watchdog.js";
import { WatchdogStore } from "../src/watchdog-store.js";

const health: WatchdogHealth = {
  controlPlane: { pid: 1, startedAt: 1, database: true },
  processingPaused: false,
  attempts: [],
  outbox: { pendingCount: 0, oldestPendingAgeMs: null, unknownCount: 0, failedCount: 0 },
  source: { configured: false, connected: false },
};

describe("WatchdogMonitor 保守告警", () => {
  it("stale Worker 告警，长心跳恢复，等待审批不误报", () => {
    const monitor = new WatchdogMonitor();
    const now = 1_000_000;
    const stale = monitor.evaluate(
      {
        ...health,
        attempts: [
          {
            id: "at_1",
            workItemId: "wi_1",
            role: "execute",
            status: "RUNNING",
            heartbeatAt: now - 100_000,
            leaseExpiresAt: null,
            workerPid: 42,
            fence: 1,
          },
        ],
      },
      now,
    );
    expect(stale.some((action) => action.open?.type === "WORKER_STALE")).toBe(true);
    const healthy = monitor.evaluate(
      {
        ...health,
        attempts: [
          {
            id: "at_1",
            workItemId: "wi_1",
            role: "execute",
            status: "RUNNING",
            heartbeatAt: now + 1000,
            leaseExpiresAt: null,
            workerPid: 42,
            fence: 1,
          },
        ],
      },
      now + 2000,
    );
    expect(healthy.some((action) => action.resolve?.type === "WORKER_STALE")).toBe(true);
    expect(healthy.some((action) => action.open?.type === "WORKER_STALE")).toBe(false);
    expect(monitor.evaluate(health, now + 3000).some((action) => action.open)).toBe(false);
  });

  it("暂停派工与睡眠唤醒不制造 stale", () => {
    const monitor = new WatchdogMonitor();
    const now = 1_000_000;
    const attempt = {
      id: "at_2",
      workItemId: "wi_2",
      role: "execute",
      status: "RUNNING",
      heartbeatAt: now - 200_000,
      leaseExpiresAt: null,
      workerPid: 42,
      fence: 1,
    };
    expect(
      monitor
        .evaluate({ ...health, processingPaused: true, attempts: [attempt] }, now)
        .some((action) => action.open?.type === "WORKER_STALE"),
    ).toBe(false);
    expect(
      monitor
        .evaluate({ ...health, attempts: [attempt] }, now + 1000)
        .some((action) => action.open?.type === "WORKER_STALE"),
    ).toBe(true);
    expect(
      monitor
        .evaluate({ ...health, attempts: [attempt] }, now + 6 * 60_000)
        .some((action) => action.open?.type === "WORKER_STALE"),
    ).toBe(false);
  });

  it("Outbox UNKNOWN 与堵塞按证据开闭", () => {
    const monitor = new WatchdogMonitor();
    const open = monitor.evaluate({
      ...health,
      outbox: { pendingCount: 2, oldestPendingAgeMs: 400_000, unknownCount: 1, failedCount: 0 },
    });
    expect(open.some((action) => action.open?.type === "OUTBOX_UNKNOWN")).toBe(true);
    expect(open.some((action) => action.open?.type === "OUTBOX_BLOCKED")).toBe(true);
    expect(monitor.evaluate(health).some((action) => action.open)).toBe(false);
  });
});

describe("WatchdogStore", () => {
  it("Finding 去重与解决", () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-watchdog-store-"));
    const base = new SqliteSuperAgentStore(join(home, "control.sqlite"));
    const store = new WatchdogStore(base.db);
    store.open("WORKER_STALE", "at_1", { ageMs: 1 });
    store.open("WORKER_STALE", "at_1", { ageMs: 2 });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.evidence.ageMs).toBe(2);
    store.resolve("WORKER_STALE", "at_1");
    expect(store.list()).toHaveLength(0);
    expect(store.db.prepare("PRAGMA user_version").get()!.user_version).toBe(6);
    base.close();
    rmSync(home, { recursive: true, force: true });
  });
});
