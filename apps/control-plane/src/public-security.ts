import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

export type PublicRole = "viewer" | "operator" | "admin";

export interface PublicPrincipal {
  subject: string;
  roles: PublicRole[];
  issuer: string;
}

export interface PublicSecurityOptions {
  publicUrl?: string;
  trustedHosts?: string[];
  trustedOrigins?: string[];
  trustProxy?: boolean;
  requireTls?: boolean;
  rateLimitPerMinute?: number;
  allowInsecureForTest?: boolean;
}

export interface OidcOptions {
  issuer: string;
  audience: string;
  jwksUrl?: string;
  sharedSecret?: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function principalFromPayload(payload: JWTPayload): PublicPrincipal {
  if (!payload.sub || !payload.iss) throw new Error("OIDC token missing sub/iss");
  const claims = Array.isArray(payload.roles) ? payload.roles : [];
  const roles = claims.filter(
    (role): role is PublicRole => role === "viewer" || role === "operator" || role === "admin",
  );
  if (roles.length === 0) throw new Error("OIDC token has no Spcode role");
  return { subject: payload.sub, roles: [...new Set(roles)], issuer: payload.iss };
}

/** OIDC 只负责认证；授权由最小角色决定，不用配对码替代正式身份。 */
export class OidcVerifier {
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly options: OidcOptions) {
    if (!options.sharedSecret && !options.jwksUrl) throw new Error("OIDC requires jwksUrl or sharedSecret");
    if (options.jwksUrl) this.jwks = createRemoteJWKSet(new URL(options.jwksUrl));
  }

  async verify(token: string): Promise<PublicPrincipal> {
    if (!this.options.issuer || !this.options.audience) throw new Error("OIDC issuer/audience not configured");
    const result = await jwtVerify(token, this.jwks ?? new TextEncoder().encode(this.options.sharedSecret), {
      issuer: this.options.issuer,
      audience: this.options.audience,
    });
    return principalFromPayload(result.payload);
  }
}

export class IdentityStore {
  constructor(private readonly db: DatabaseSync) {}

  create(principal: PublicPrincipal, ttlMs = 12 * 60 * 60_000): string {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO identity_sessions(token_hash, subject, roles_json, issuer, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(hash(token), principal.subject, JSON.stringify(principal.roles), principal.issuer, now, now + ttlMs);
    return token;
  }

  authenticate(token: string | undefined): PublicPrincipal | null {
    if (!token) return null;
    const row = this.db
      .prepare("SELECT subject, roles_json, issuer, expires_at FROM identity_sessions WHERE token_hash = ?")
      .get(hash(token)) as { subject: string; roles_json: string; issuer: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= Date.now()) return null;
    return { subject: row.subject, roles: JSON.parse(row.roles_json), issuer: row.issuer };
  }
}

export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly limitPerMinute: number) {}

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    if (this.buckets.size > 10_000) {
      for (const [bucket, value] of this.buckets) if (value.resetAt <= now) this.buckets.delete(bucket);
    }
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + 60_000 });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (current.count >= this.limitPerMinute) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
    }
    current.count++;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

export function isPublicDeployment(options: PublicSecurityOptions): boolean {
  return !!options.publicUrl;
}

export function publicHost(options: PublicSecurityOptions): string | null {
  return options.publicUrl ? new URL(options.publicUrl).host : null;
}

export function assertPublicOptions(options: PublicSecurityOptions): void {
  if (!options.publicUrl) return;
  const url = new URL(options.publicUrl);
  if (url.protocol !== "https:" && !options.allowInsecureForTest) {
    throw new Error("公网 publicUrl 必须使用 HTTPS；仅测试可显式允许 HTTP");
  }
}
