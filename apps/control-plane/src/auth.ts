import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const CONTROL_COOKIE = "spcode_control";
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function ensureDeviceToken(baseDir: string): string {
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  const file = join(baseDir, "device-token");
  if (existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    if (token.length >= 32) {
      try {
        chmodSync(file, 0o600);
      } catch {
        // Windows 无 POSIX 权限位。
      }
      return token;
    }
  }
  const token = randomBytes(32).toString("base64url");
  writeFileSync(file, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

export function tokensEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Cookie 只保存随机令牌，SQLite 只保存哈希；服务重启后已认证浏览器仍可恢复。 */
export class AuthService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly deviceToken: string,
  ) {}

  bootstrap(presentedToken: string): string | null {
    if (!tokensEqual(presentedToken, this.deviceToken)) return null;
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now);
    this.db
      .prepare("INSERT INTO auth_sessions(token_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .run(hashToken(token), now, now + SESSION_TTL_MS);
    return token;
  }

  authenticate(token: string | undefined): boolean {
    if (!token) return false;
    const row = this.db.prepare("SELECT expires_at FROM auth_sessions WHERE token_hash = ?").get(hashToken(token)) as
      | { expires_at: number }
      | undefined;
    return !!row && row.expires_at > Date.now();
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}
