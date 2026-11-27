import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../src/server.js";

const secret = "public-test-secret-with-enough-entropy";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function token(subject: string, roles: string[]): Promise<string> {
  return new SignJWT({ roles })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(subject)
    .setIssuer("https://issuer.example.com")
    .setAudience("spcode-control")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
}

async function fixture(rateLimitPerMinute = 120) {
  const home = mkdtempSync(join(tmpdir(), "spcode-public-test-"));
  const workbenchDir = join(home, "workbench");
  mkdirSync(workbenchDir, { recursive: true });
  writeFileSync(join(workbenchDir, "index.html"), "<title>Spcode public</title>");
  const plane = new ControlPlane({
    baseDir: home,
    workbenchDir,
    port: 0,
    public: {
      publicUrl: "https://agent.example.com",
      trustedHosts: ["agent.example.com"],
      trustedOrigins: ["https://agent.example.com"],
      trustProxy: true,
      requireTls: true,
      rateLimitPerMinute,
    },
    oidc: { issuer: "https://issuer.example.com", audience: "spcode-control", sharedSecret: secret },
    watchdogEnabled: false,
  });
  const { port } = await plane.start();
  cleanups.push(async () => {
    await plane.close().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  const headers = (extra: Record<string, string> = {}) => ({
    Origin: "https://agent.example.com",
    "X-Forwarded-Proto": "https",
    "X-Spcode-Control-Client": "1",
    "Content-Type": "application/json",
    ...extra,
  });
  const login = async (jwt: string) => {
    const response = await fetch(`${origin}/api/v1/auth/oidc`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ token: jwt }),
    });
    return { response, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };
  return { origin, headers, login, plane };
}

describe("公网 OIDC / TLS / Origin / 限流", () => {
  it("viewer 只读、operator 工作、admin 配置，审批审计记录外部 sub", async () => {
    const app = await fixture();
    const health = await (await fetch(`${app.origin}/api/v1/health`, { headers: app.headers() })).json();
    expect(health.authMode).toBe("oidc");
    const viewer = await app.login(await token("viewer-1", ["viewer"]));
    expect(viewer.response.status).toBe(200);
    expect(viewer.response.headers.get("set-cookie")).toContain("Secure");
    const snapshot = await fetch(`${app.origin}/api/v1/superagent/snapshot`, {
      headers: app.headers({ Cookie: viewer.cookie }),
    });
    expect(snapshot.status).toBe(200);
    const denied = await fetch(`${app.origin}/api/v1/superagent/commands`, {
      method: "POST",
      headers: app.headers({ Cookie: viewer.cookie }),
      body: JSON.stringify({
        type: "workitem.create",
        requestId: "viewer_denied",
        repo: "owner/repo",
        title: "deny",
        request: "deny",
      }),
    });
    expect(denied.status).toBe(403);

    const operator = await app.login(await token("operator-1", ["operator"]));
    const created = await fetch(`${app.origin}/api/v1/superagent/commands`, {
      method: "POST",
      headers: app.headers({ Cookie: operator.cookie }),
      body: JSON.stringify({
        type: "workitem.create",
        requestId: "operator_allowed",
        repo: "owner/repo",
        title: "allow",
        request: "allow",
      }),
    });
    expect(created.status).toBe(200);
    const state = await created.json();
    expect(state.audit[0].actorId).toBe("external:operator-1");
    const configDenied = await fetch(`${app.origin}/api/v1/superagent/commands`, {
      method: "POST",
      headers: app.headers({ Cookie: operator.cookie }),
      body: JSON.stringify({ type: "config.update", patch: { concurrency: 1 } }),
    });
    expect(configDenied.status).toBe(403);
    const admin = await app.login(await token("admin-1", ["admin"]));
    const configAllowed = await fetch(`${app.origin}/api/v1/superagent/commands`, {
      method: "POST",
      headers: app.headers({ Cookie: admin.cookie }),
      body: JSON.stringify({ type: "config.update", patch: { concurrency: 1 } }),
    });
    expect(configAllowed.status).toBe(200);
  });

  it("伪造签名、本地 bootstrap、恶意 Origin 和非 TLS 请求失败", async () => {
    const app = await fixture();
    expect((await app.login("not-a-jwt")).response.status).toBe(400);
    const bootstrap = await fetch(`${app.origin}/api/v1/auth/bootstrap`, {
      method: "POST",
      headers: app.headers(),
      body: "{}",
    });
    expect(bootstrap.status).toBe(403);
    const noTls = await fetch(`${app.origin}/api/v1/health`, { headers: app.headers({ "X-Forwarded-Proto": "http" }) });
    expect(noTls.status).toBe(403);
    const badOrigin = await app.login(await token("operator-1", ["operator"]));
    const forged = await fetch(`${app.origin}/api/v1/auth/oidc`, {
      method: "POST",
      headers: app.headers({ Origin: "https://evil.example" }),
      body: JSON.stringify({ token: await token("operator-1", ["operator"]) }),
    });
    expect(forged.status).toBe(403);
    expect(badOrigin.response.status).toBe(200);
  });

  it("每 IP/路由限流并返回 Retry-After", async () => {
    const app = await fixture(2);
    expect((await fetch(`${app.origin}/api/v1/health`, { headers: app.headers() })).status).toBe(200);
    expect((await fetch(`${app.origin}/api/v1/health`, { headers: app.headers() })).status).toBe(200);
    const limited = await fetch(`${app.origin}/api/v1/health`, { headers: app.headers() });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
