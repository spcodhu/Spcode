import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InjectedOutboxFault } from "./integrations/feishu/outbox.js";
import { ControlPlane } from "./server.js";
import { InjectedWorkerFault } from "./worker-manager.js";

const here = dirname(fileURLToPath(import.meta.url));

function envList(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

/** 本地组合根；独立 Node 入口和测试共用，不 import Electron。 */
export function createLocalControlPlane(
  options: Partial<ConstructorParameters<typeof ControlPlane>[0]> = {},
): ControlPlane {
  return new ControlPlane({
    workbenchDir: options.workbenchDir ?? process.env.SPCODE_WORKBENCH_DIR ?? resolve(here, "../../workbench/dist"),
    public:
      options.public ??
      (process.env.SPCODE_PUBLIC_URL
        ? {
            publicUrl: process.env.SPCODE_PUBLIC_URL,
            trustedHosts: envList(process.env.SPCODE_TRUSTED_HOSTS),
            trustedOrigins: envList(process.env.SPCODE_TRUSTED_ORIGINS),
            trustProxy: process.env.SPCODE_TRUST_PROXY !== "0",
            requireTls: process.env.SPCODE_REQUIRE_TLS !== "0",
            allowInsecureForTest: process.env.SPCODE_ALLOW_INSECURE_PUBLIC === "1",
            rateLimitPerMinute: Number(process.env.SPCODE_RATE_LIMIT_PER_MINUTE ?? 120),
          }
        : undefined),
    oidc:
      options.oidc ??
      (process.env.SPCODE_OIDC_ISSUER && process.env.SPCODE_OIDC_AUDIENCE
        ? {
            issuer: process.env.SPCODE_OIDC_ISSUER,
            audience: process.env.SPCODE_OIDC_AUDIENCE,
            jwksUrl: process.env.SPCODE_OIDC_JWKS_URL,
            sharedSecret: process.env.SPCODE_OIDC_SHARED_SECRET,
          }
        : undefined),
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
