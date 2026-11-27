import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { writeFileAtomic } from "@spcode/shared/node";
import type { ArtifactMeta } from "@spcode/shared/superagent";
import type { ObjectArtifactBackend } from "./object-artifact-backend.js";

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "application/x-ndjson",
  "text/x-diff",
  "application/octet-stream",
]);

export interface ArtifactRecord extends ArtifactMeta {
  storageKey: string;
  metadata: Record<string, unknown>;
}

class LocalObjectBackend implements ObjectArtifactBackend {
  constructor(private readonly contentDir: string) {
    mkdirSync(contentDir, { recursive: true, mode: 0o700 });
  }
  put(key: string, encodedContent: Buffer): void {
    const file = join(this.contentDir, key.slice(0, 2), `${key.slice(2)}.bin`);
    mkdirSync(join(this.contentDir, key.slice(0, 2)), { recursive: true, mode: 0o700 });
    writeFileAtomic(file, encodedContent.toString("base64"), { mode: 0o600 });
  }
  get(key: string): Buffer {
    const file = join(this.contentDir, key.slice(0, 2), `${key.slice(2)}.bin`);
    if (!existsSync(file)) throw new Error("Artifact 内容缺失");
    return readFileSync(file);
  }
  delete(key: string): void {
    const file = join(this.contentDir, key.slice(0, 2), `${key.slice(2)}.bin`);
    if (existsSync(file)) rmSync(file, { force: true });
  }
}

export function migrateArtifactSchema(db: DatabaseSync): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version >= 4) return;
  if (version !== 3) throw new Error("Artifact schema 需要从 v3 迁移");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE plan_revisions ADD COLUMN artifact_id TEXT");
    db.exec("ALTER TABLE attempts ADD COLUMN log_artifact_id TEXT");
    db.exec("ALTER TABLE work_items ADD COLUMN diff_artifact_id TEXT");
    db.exec("ALTER TABLE artifacts ADD COLUMN kind TEXT NOT NULL DEFAULT 'file'");
    db.exec("PRAGMA user_version = 4");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** 私有 Artifact Store：数据库保存元数据，内容由本地磁盘或 S3/OSS 后端按 SHA-256 寻址。 */
export class ArtifactStore {
  private readonly backend: ObjectArtifactBackend;

  constructor(
    readonly baseDir: string,
    readonly db: DatabaseSync,
    backend?: ObjectArtifactBackend,
  ) {
    this.backend = backend ?? new LocalObjectBackend(join(baseDir, "artifact-content"));
  }

  put(input: {
    workItemId?: string;
    kind: string;
    content: string | Buffer;
    mimeType?: string;
    metadata?: Record<string, unknown>;
  }): ArtifactRecord {
    const content = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, "utf8");
    if (content.byteLength === 0 || content.byteLength > MAX_ARTIFACT_BYTES)
      throw new Error("Artifact 为空或超过 16MB 限制");
    const mimeType = input.mimeType ?? "text/plain";
    if (!ALLOWED_MIME.has(mimeType)) throw new Error(`不允许的 Artifact 类型：${mimeType}`);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const storageKey = sha256;
    this.backend.put(storageKey, content);
    const existing = this.db.prepare("SELECT * FROM artifacts WHERE storage_key = ?").get(storageKey) as
      | Record<string, any>
      | undefined;
    if (existing) return this.map(existing);
    const id = `ar_${randomUUID()}`;
    const now = Date.now();
    const metadata = { ...input.metadata, encoding: "base64" };
    this.db
      .prepare(
        `INSERT INTO artifacts(id, work_item_id, storage_key, sha256, size, mime_type, visibility, metadata_json, created_at, kind)
         VALUES (?, ?, ?, ?, ?, ?, 'private', ?, ?, ?)`,
      )
      .run(
        id,
        input.workItemId ?? null,
        storageKey,
        sha256,
        content.byteLength,
        mimeType,
        JSON.stringify(metadata),
        now,
        input.kind,
      );
    return this.get(id)!;
  }

  get(id: string): ArtifactRecord | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Record<string, any> | undefined;
    return row ? this.map(row) : null;
  }

  list(limit = 300): ArtifactRecord[] {
    return (
      this.db.prepare("SELECT * FROM artifacts ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as Array<
        Record<string, any>
      >
    ).map((row) => this.map(row));
  }

  read(record: ArtifactRecord): Buffer {
    if (!/^[0-9a-f]{64}$/.test(record.storageKey)) throw new Error("Artifact storageKey 非法");
    const encoded = this.backend.get(record.storageKey);
    const content = Buffer.from(encoded.toString("utf8"), "base64");
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (sha256 !== record.sha256 || content.byteLength !== record.size || content.byteLength === 0) {
      throw new Error("Artifact 内容哈希或大小不匹配");
    }
    return content;
  }

  /** 生命周期清理：先删内容，再删元数据与分享授权；失败保留元数据以便对账。 */
  prune(before: number): number {
    const rows = this.db
      .prepare("SELECT storage_key, id FROM artifacts WHERE created_at < ?")
      .all(before) as unknown as Array<{ storage_key: string; id: string }>;
    let count = 0;
    for (const row of rows) {
      this.backend.delete(row.storage_key);
      this.db.prepare("DELETE FROM share_links WHERE artifact_id = ?").run(row.id);
      this.db.prepare("DELETE FROM artifacts WHERE id = ?").run(row.id);
      count++;
    }
    return count;
  }

  private map(row: Record<string, any>): ArtifactRecord {
    return {
      id: row.id,
      workItemId: row.work_item_id,
      kind: row.kind,
      storageKey: row.storage_key,
      sha256: row.sha256,
      size: row.size,
      mimeType: row.mime_type,
      visibility: "private",
      createdAt: row.created_at,
      metadata: JSON.parse(row.metadata_json),
    };
  }
}
