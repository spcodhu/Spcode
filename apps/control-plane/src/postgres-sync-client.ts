import { Worker } from "node:worker_threads";

interface QueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
  command: string;
}

interface PendingResult {
  ok: boolean;
  result?: QueryResult;
  error?: string;
}

const BUFFER_SIZE = 16 * 1024 * 1024;

function placeholders(sql: string): string {
  let index = 0;
  let single = false;
  let double = false;
  let lineComment = false;
  let blockComment = false;
  let output = "";
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!;
    const next = sql[i + 1];
    if (lineComment) {
      output += char;
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      output += char;
      if (char === "*" && next === "/") {
        output += next;
        i++;
        blockComment = false;
      }
      continue;
    }
    if (!single && !double && char === "-" && next === "-") {
      output += char + next;
      i++;
      lineComment = true;
      continue;
    }
    if (!single && !double && char === "/" && next === "*") {
      output += char + next;
      i++;
      blockComment = true;
      continue;
    }
    if (char === "'" && !double) {
      single = !single;
      output += char;
      continue;
    }
    if (char === '"' && !single) {
      double = !double;
      output += char;
      continue;
    }
    if (char === "?" && !single && !double) {
      index++;
      output += `$${index}`;
    } else {
      output += char;
    }
  }
  return output;
}

function translateSql(sql: string): string {
  let translated = sql.trim().replace(/^BEGIN IMMEDIATE$/i, "BEGIN");
  translated = translated.replace(
    /json_extract\(([^,]+),\s*'\$\.([^']+)'\)/g,
    (_match, column: string, path: string) => {
      const parts = path
        .split(".")
        .map((part) => `'${part.replace(/'/g, "''")}'`)
        .join(", ");
      return `jsonb_extract_path_text(${column}::jsonb, ${parts})`;
    },
  );
  return placeholders(translated);
}

/** 让现有同步领域端口在真实 PG 上运行；所有同一事务的查询复用一个 worker/client。 */
export class PostgresSyncClient {
  private readonly shared = new SharedArrayBuffer(BUFFER_SIZE + 8);
  private readonly state = new Int32Array(this.shared, 0, 2);
  private readonly worker: Worker;
  private closed = false;

  constructor(connectionString: string, workerFile: URL) {
    this.worker = new Worker(workerFile, {
      workerData: { connectionString, shared: this.shared },
    });
    this.wait();
  }

  query(sql: string, params: unknown[] = []): QueryResult {
    if (this.closed) throw new Error("PostgreSQL client is closed");
    Atomics.store(this.state, 0, 0);
    Atomics.store(this.state, 1, 0);
    this.worker.postMessage({ sql: translateSql(sql), params });
    return this.wait();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.postMessage({ type: "close" });
    void this.worker.terminate();
  }

  private wait(): QueryResult {
    const status = Atomics.wait(this.state, 0, 0, 30_000);
    if (status === "timed-out") throw new Error("PostgreSQL query timed out");
    const length = Atomics.load(this.state, 1);
    if (length <= 0 || length > BUFFER_SIZE) throw new Error("PostgreSQL response is empty or too large");
    const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(this.shared, 8, length))) as PendingResult;
    if (!payload.ok || !payload.result) throw new Error(payload.error ?? "PostgreSQL query failed");
    return payload.result;
  }
}

export { translateSql as postgresSql };
