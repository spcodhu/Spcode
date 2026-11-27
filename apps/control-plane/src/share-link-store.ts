import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface ShareLinkRecord {
  id: string;
  artifactId: string;
  scope: string;
  expiresAt: number;
  revokedAt: number | null;
  createdBy: string;
  createdAt: number;
}

export class ShareLinkStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: { artifactId: string; actorId: string; expiresAt: number; scope?: string }): {
    id: string;
    token: string;
    record: ShareLinkRecord;
  } {
    if (input.scope && input.scope !== "read") throw new Error("ShareLink 只允许 read scope");
    const ttl = input.expiresAt - Date.now();
    if (ttl <= 0 || ttl > 7 * 24 * 60 * 60_000) throw new Error("ShareLink 有效期必须在 7 天内");
    const id = `sl_${randomUUID()}`;
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO share_links(id, artifact_id, token_hash, scope, expires_at, created_by, created_at) VALUES (?, ?, ?, 'read', ?, ?, ?)",
      )
      .run(id, input.artifactId, hash(token), input.expiresAt, input.actorId, now);
    this.db
      .prepare(
        "INSERT INTO approvals(id, subject_id, subject_hash, kind, actor_id, policy_version, decision, created_at) VALUES (?, ?, ?, 'SHARE_LINK', ?, 1, 'APPROVED', ?)",
      )
      .run(`ap_${randomUUID()}`, id, hash(token), input.actorId, now);
    return {
      id,
      token,
      record: {
        id,
        artifactId: input.artifactId,
        scope: "read",
        expiresAt: input.expiresAt,
        revokedAt: null,
        createdBy: input.actorId,
        createdAt: now,
      },
    };
  }

  resolve(token: string): { link: ShareLinkRecord; artifactId: string } | null {
    const row = this.db.prepare("SELECT * FROM share_links WHERE token_hash = ?").get(hash(token)) as
      | Record<string, any>
      | undefined;
    if (!row || row.revoked_at !== null || row.expires_at <= Date.now()) return null;
    return { link: this.map(row), artifactId: row.artifact_id };
  }

  revoke(id: string, actorId: string, allowAdmin = false): void {
    const row = this.db.prepare("SELECT created_by FROM share_links WHERE id = ?").get(id) as
      | { created_by: string }
      | undefined;
    if (!row || (!allowAdmin && row.created_by !== actorId)) throw new Error("只有分享创建者可以撤销 ShareLink");
    this.db.prepare("UPDATE share_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), id);
  }

  list(artifactId?: string): ShareLinkRecord[] {
    const rows = (artifactId
      ? this.db.prepare("SELECT * FROM share_links WHERE artifact_id = ? ORDER BY created_at DESC").all(artifactId)
      : this.db.prepare("SELECT * FROM share_links ORDER BY created_at DESC LIMIT 200").all()) as unknown as Array<
      Record<string, any>
    >;
    return rows.map((row) => this.map(row));
  }

  private map(row: Record<string, any>): ShareLinkRecord {
    return {
      id: row.id,
      artifactId: row.artifact_id,
      scope: row.scope,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }
}
