import { defaultProviders, HttpEffectExecutor } from "./remote.js";

const controlUrl = process.env.SPCODE_CONTROL_PLANE_URL ?? "http://127.0.0.1:47831";
const token = process.env.SPCODE_EXECUTOR_TOKEN;
if (!token) throw new Error("SPCODE_EXECUTOR_TOKEN 未配置");
const executor = new HttpEffectExecutor(
  controlUrl,
  token,
  process.env.SPCODE_EXECUTOR_ID ?? `executor-${process.pid}`,
  defaultProviders(controlUrl, token),
);
executor.start(Number(process.env.SPCODE_EXECUTOR_POLL_MS ?? 250));
process.on("SIGTERM", () => {
  executor.stop();
  process.exit(0);
});
process.on("SIGINT", () => {
  executor.stop();
  process.exit(0);
});
