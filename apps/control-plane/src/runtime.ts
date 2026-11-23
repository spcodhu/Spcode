import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InjectedOutboxFault } from "./integrations/feishu/outbox.js";
import { ControlPlane } from "./server.js";
import { InjectedWorkerFault } from "./worker-manager.js";

const here = dirname(fileURLToPath(import.meta.url));

/** 本地组合根；独立 Node 入口和测试共用，不 import Electron。 */
export function createLocalControlPlane(
  options: Partial<ConstructorParameters<typeof ControlPlane>[0]> = {},
): ControlPlane {
  return new ControlPlane({
    workbenchDir: options.workbenchDir ?? process.env.SPCODE_WORKBENCH_DIR ?? resolve(here, "../../workbench/dist"),
    workerPollMs: options.workerPollMs ?? Number(process.env.SPCODE_WORKER_POLL_MS ?? 250),
    watchdogEnabled: options.watchdogEnabled ?? process.env.SPCODE_WATCHDOG !== "0",
    afterCommit:
      options.afterCommit ??
      (process.env.SPCODE_TEST_AFTER_COMMIT === "1"
        ? () => {
            throw new InjectedWorkerFault("SPCODE_TEST_AFTER_COMMIT");
          }
        : undefined),
    afterOutboxSend:
      options.afterOutboxSend ??
      (process.env.SPCODE_TEST_AFTER_OUTBOX_SEND === "1"
        ? () => {
            throw new InjectedOutboxFault("SPCODE_TEST_AFTER_OUTBOX_SEND");
          }
        : undefined),
    ...options,
  });
}
