import { createLocalControlPlane } from "./runtime.js";

const port = Number(process.env.SPCODE_CONTROL_PORT ?? 47831);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("SPCODE_CONTROL_PORT 无效");

const controlPlane = createLocalControlPlane({ port, exitOnStop: true });
const { port: boundPort, deviceToken } = await controlPlane.start();
const url = `http://127.0.0.1:${boundPort}/?view=superagent#bootstrap=${deviceToken}`;
console.log(`[control-plane] Spcode 本地工作台：${url}`);
console.log(`[control-plane] 仅监听 127.0.0.1；关闭 Electron 不会停止本服务。`);

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[control-plane] 收到 ${signal}，正在优雅停止`);
  await controlPlane.close();
  process.exit(0);
}

process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
