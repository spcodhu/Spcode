import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { S3ObjectBackend } from "../src/object-artifact-backend.js";
import { SqliteSuperAgentStore } from "../src/store-sqlite.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("S3/OSS 兼容 Artifact 后端", () => {
  it("AWS SDK 上传/下载/删除与生命周期一致", async () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-s3-test-"));
    const server = new Worker(new URL("./s3-server-worker.ts", import.meta.url), {
      workerData: { directory: join(home, "s3-data") },
    });
    const address = await new Promise<{ port: number }>((resolve, reject) => {
      server.once("message", (message: { type: string; address: { port: number } }) => resolve(message.address));
      server.once("error", reject);
    });
    cleanups.push(async () => {
      server.postMessage({ type: "close" });
      await server.terminate();
      rmSync(home, { recursive: true, force: true });
    });
    const backend = new S3ObjectBackend({
      bucket: "spcode-test",
      endpoint: `http://127.0.0.1:${address.port}`,
      region: "us-east-1",
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      forcePathStyle: true,
      workerFile: new URL("../dist/s3-sync-worker.mjs", import.meta.url),
    });
    const store = new SqliteSuperAgentStore(join(home, "control.sqlite"), { artifactBackend: backend });
    const artifact = store.artifacts.put({ kind: "report", content: "s3 report", mimeType: "text/plain" });
    expect(store.artifacts.read(artifact).toString()).toBe("s3 report");
    expect(store.artifacts.prune(Date.now() + 1)).toBe(1);
    expect(store.artifacts.get(artifact.id)).toBeNull();
    expect(() => store.artifacts.read(artifact)).toThrow();
    store.close();
    backend.close();
  }, 60_000);
});
