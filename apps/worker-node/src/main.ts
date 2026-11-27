import { WorkerNodeApp } from "./node.js";

const controlUrl = process.env.SPCODE_CONTROL_PLANE_URL ?? "http://127.0.0.1:47831";
const dataDir = process.env.SPCODE_WORKER_NODE_DATA_DIR ?? `${process.env.HOME}/.spcode/worker-node`;
const app = new WorkerNodeApp({
  controlUrl,
  name: process.env.SPCODE_WORKER_NODE_NAME ?? `worker-${process.pid}`,
  dataDir,
  pairToken: process.env.SPCODE_WORKER_PAIR_TOKEN,
  nodeId: process.env.SPCODE_WORKER_NODE_ID,
  nodeToken: process.env.SPCODE_WORKER_NODE_TOKEN,
  capacity: Number(process.env.SPCODE_WORKER_NODE_CAPACITY ?? 1),
  pollMs: Number(process.env.SPCODE_WORKER_NODE_POLL_MS ?? 250),
  repoSource: (repo) => process.env.SPCODE_WORKER_REPO_PATH ?? `https://github.com/${repo}.git`,
});

await app.start();
console.log(`[worker-node] ${process.env.SPCODE_WORKER_NODE_NAME ?? "worker"} connected to ${controlUrl}`);
process.on("SIGTERM", () => void app.stop().then(() => process.exit(0)));
process.on("SIGINT", () => void app.stop().then(() => process.exit(0)));
