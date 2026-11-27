import { parentPort, workerData } from "node:worker_threads";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const shared = workerData.shared as SharedArrayBuffer;
const state = new Int32Array(shared, 0, 2);
const client = new S3Client(workerData.config);

function finish(ok: boolean, result?: unknown, error?: unknown): void {
  const payload = Buffer.from(
    JSON.stringify({ ok, result, error: error instanceof Error ? error.message : String(error) }),
    "utf8",
  );
  new Uint8Array(shared, 8, payload.byteLength).set(payload);
  Atomics.store(state, 1, payload.byteLength);
  Atomics.store(state, 0, ok ? 1 : 2);
  Atomics.notify(state, 0);
}

finish(true, { ready: true });
parentPort?.on(
  "message",
  async (message: { op?: string; bucket?: string; key?: string; body?: string; contentType?: string }) => {
    try {
      if (message.op === "put") {
        await client.send(
          new PutObjectCommand({
            Bucket: message.bucket,
            Key: message.key,
            Body: Buffer.from(message.body ?? "", "base64"),
            ContentType: message.contentType,
          }),
        );
        finish(true, { ok: true });
      } else if (message.op === "get") {
        const response = await client.send(new GetObjectCommand({ Bucket: message.bucket, Key: message.key }));
        const chunks: Buffer[] = [];
        for await (const chunk of response.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
        finish(true, { body: Buffer.concat(chunks).toString("base64") });
      } else if (message.op === "delete") {
        await client.send(new DeleteObjectCommand({ Bucket: message.bucket, Key: message.key }));
        finish(true, { ok: true });
      }
    } catch (error) {
      finish(false, undefined, error);
    }
  },
);
