import { parentPort, workerData } from "node:worker_threads";
import { Client } from "pg";

const shared = workerData.shared as SharedArrayBuffer;
const state = new Int32Array(shared, 0, 2);
const client = new Client({ connectionString: workerData.connectionString });

function finish(ok: boolean, result?: unknown, error?: unknown): void {
  const payload = Buffer.from(
    JSON.stringify({ ok, result, error: error instanceof Error ? error.message : String(error) }),
    "utf8",
  );
  const bytes = new Uint8Array(shared, 8, payload.byteLength);
  bytes.set(payload);
  Atomics.store(state, 1, payload.byteLength);
  Atomics.store(state, 0, ok ? 1 : 2);
  Atomics.notify(state, 0);
}

await client.connect();
finish(true, { rows: [], rowCount: 0, command: "CONNECT" });

parentPort?.on("message", async (message: { sql?: string; params?: unknown[]; type?: string }) => {
  if (message.type === "close") {
    await client.end();
    return;
  }
  if (!message.sql) return;
  try {
    const result = await client.query({ text: message.sql, values: message.params });
    finish(true, { rows: result.rows, rowCount: result.rowCount, command: result.command });
  } catch (error) {
    finish(false, undefined, error);
  }
});
