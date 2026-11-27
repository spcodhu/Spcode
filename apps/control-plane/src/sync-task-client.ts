import { Worker } from "node:worker_threads";

const BUFFER_SIZE = 32 * 1024 * 1024;

/** 小同步端口：让 Artifact API 的同步元数据路径可复用异步对象存储 SDK。 */
export class SyncTaskClient {
  private readonly shared = new SharedArrayBuffer(BUFFER_SIZE + 8);
  private readonly state = new Int32Array(this.shared, 0, 2);
  private readonly worker: Worker;

  constructor(workerData: Record<string, unknown>, workerFile: URL) {
    this.worker = new Worker(workerFile, { workerData: { ...workerData, shared: this.shared } });
    this.wait();
  }

  call<T>(payload: unknown): T {
    Atomics.store(this.state, 0, 0);
    Atomics.store(this.state, 1, 0);
    this.worker.postMessage(payload);
    return this.wait() as T;
  }

  close(): void {
    this.worker.postMessage({ type: "close" });
    void this.worker.terminate();
  }

  private wait<T>(): T {
    const status = Atomics.wait(this.state, 0, 0, 60_000);
    if (status === "timed-out") throw new Error("Object storage operation timed out");
    const length = Atomics.load(this.state, 1);
    if (length <= 0 || length > BUFFER_SIZE) throw new Error("Object storage response too large");
    const result = JSON.parse(new TextDecoder().decode(new Uint8Array(this.shared, 8, length))) as {
      ok: boolean;
      result?: T;
      error?: string;
    };
    if (!result.ok) throw new Error(result.error ?? "Object storage operation failed");
    return result.result as T;
  }
}
