import { parentPort, workerData } from "node:worker_threads";
import S3rver from "s3rver";

const server = new S3rver({
  directory: workerData.directory,
  configureBuckets: [{ name: "spcode-test" }],
  address: "127.0.0.1",
  port: 0,
});
const address = await server.run();
parentPort?.postMessage({ type: "ready", address });
parentPort?.on("message", (message: { type?: string }) => {
  if (message.type === "close") void server.close();
});
