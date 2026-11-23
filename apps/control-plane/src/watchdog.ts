export interface WatchdogHealth {
  controlPlane: { pid: number; startedAt: number; database: true };
  processingPaused: boolean;
  attempts: Array<{
    id: string;
    workItemId: string;
    role: string;
    status: string;
    heartbeatAt: number | null;
    leaseExpiresAt: number | null;
    workerPid: number | null;
    fence: number;
  }>;
  outbox: { pendingCount: number; oldestPendingAgeMs: number | null; unknownCount: number; failedCount: number };
  source: { configured: boolean; connected: boolean };
}

export interface WatchdogAction {
  open?: { type: string; subjectId: string; workItemId?: string; evidence: Record<string, unknown> };
  resolve?: { type: string; subjectId: string };
}

const STALE_ATTEMPT_MS = 90_000;
const SLEEP_GRACE_MS = 5 * 60_000;
const OUTBOX_OLD_MS = 5 * 60_000;

/** 纯判定：只产生 Finding 动作，不触达 Worker、数据库、网络或 Git。 */
export class WatchdogMonitor {
  private lastPoll = 0;

  evaluate(health: WatchdogHealth, now = Date.now()): WatchdogAction[] {
    const previous = this.lastPoll;
    this.lastPoll = now;
    if (previous && now - previous > SLEEP_GRACE_MS) return []; // 休眠唤醒先观察一个周期，不误报。
    const actions: WatchdogAction[] = [{ resolve: { type: "CONTROL_PLANE_UNREACHABLE", subjectId: "control-plane" } }];
    if (!health.processingPaused) {
      for (const attempt of health.attempts) {
        const heartbeat = attempt.heartbeatAt ?? attempt.leaseExpiresAt ?? health.controlPlane.startedAt;
        if (now - heartbeat > STALE_ATTEMPT_MS) {
          actions.push({
            open: {
              type: "WORKER_STALE",
              subjectId: attempt.id,
              workItemId: attempt.workItemId,
              evidence: {
                role: attempt.role,
                status: attempt.status,
                heartbeatAt: heartbeat,
                ageMs: now - heartbeat,
                workerPid: attempt.workerPid,
                fence: attempt.fence,
              },
            },
          });
        } else {
          actions.push({ resolve: { type: "WORKER_STALE", subjectId: attempt.id } });
        }
      }
    }
    if (health.outbox.unknownCount > 0) {
      actions.push({
        open: {
          type: "OUTBOX_UNKNOWN",
          subjectId: "outbox",
          evidence: { unknownCount: health.outbox.unknownCount },
        },
      });
    } else {
      actions.push({ resolve: { type: "OUTBOX_UNKNOWN", subjectId: "outbox" } });
    }
    if (health.outbox.oldestPendingAgeMs !== null && health.outbox.oldestPendingAgeMs > OUTBOX_OLD_MS) {
      actions.push({
        open: {
          type: "OUTBOX_BLOCKED",
          subjectId: "outbox",
          evidence: {
            pendingCount: health.outbox.pendingCount,
            oldestPendingAgeMs: health.outbox.oldestPendingAgeMs,
            failedCount: health.outbox.failedCount,
          },
        },
      });
    } else {
      actions.push({ resolve: { type: "OUTBOX_BLOCKED", subjectId: "outbox" } });
    }
    if (health.source.configured && !health.source.connected) {
      actions.push({ open: { type: "SOURCE_DISCONNECTED", subjectId: "feishu", evidence: { connected: false } } });
    } else {
      actions.push({ resolve: { type: "SOURCE_DISCONNECTED", subjectId: "feishu" } });
    }
    return actions;
  }

  unreachable(now = Date.now()): WatchdogAction {
    return {
      open: {
        type: "CONTROL_PLANE_UNREACHABLE",
        subjectId: "control-plane",
        evidence: { lastSeenAt: this.lastPoll || now, observedAt: now },
      },
    };
  }
}
