import { readRuntimeInfo } from "./discovery.js";
import { type WatchdogHealth, WatchdogMonitor } from "./watchdog.js";

const baseDir = process.env.SPCODE_SUPERAGENT_DIR!;
const pollMs = Number(process.env.SPCODE_WATCHDOG_POLL_MS ?? 5000);
const monitor = new WatchdogMonitor();
let lastError = "";

async function api(
  path: string,
  runtime: NonNullable<ReturnType<typeof readRuntimeInfo>>,
  init?: RequestInit,
): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${runtime.serviceToken}`,
      "X-Spcode-Control-Client": "1",
      "Content-Type": "application/json",
      ...init?.headers,
    },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`Watchdog API ${path} -> ${response.status}`);
}

async function poll(): Promise<void> {
  const runtime = readRuntimeInfo(baseDir);
  if (!runtime) {
    if (lastError !== "missing-runtime") console.warn("[watchdog] 控制面 runtime 不存在，等待恢复");
    lastError = "missing-runtime";
    return;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/api/v1/watchdog/health`, {
      headers: { Authorization: `Bearer ${runtime.serviceToken}`, "X-Spcode-Control-Client": "1" },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`health -> ${response.status}`);
    const health = (await response.json()) as WatchdogHealth;
    if (lastError) {
      const action = monitor.unreachable();
      await api("/api/v1/watchdog/findings", runtime, { method: "POST", body: JSON.stringify(action) });
      lastError = "";
    }
    for (const action of monitor.evaluate(health)) {
      if (action.open) {
        await api("/api/v1/watchdog/findings", runtime, { method: "POST", body: JSON.stringify(action) });
      } else if (action.resolve) {
        await api("/api/v1/watchdog/resolve", runtime, { method: "POST", body: JSON.stringify(action.resolve) });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastError) console.warn(`[watchdog] ${message}`);
    lastError = message;
  }
}

const timer = setInterval(() => void poll(), pollMs);
void poll();
process.on("SIGTERM", () => {
  clearInterval(timer);
  process.exit(0);
});
process.on("SIGINT", () => {
  clearInterval(timer);
  process.exit(0);
});
