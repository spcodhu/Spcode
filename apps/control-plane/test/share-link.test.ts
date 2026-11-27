import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../src/server.js";
import { SqliteSuperAgentStore } from "../src/store-sqlite.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("ShareLink 过期与撤销", () => {
  it("匿名链接可读，撤销和过期立即失效且列表不含 token", async () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-share-test-"));
    const workbenchDir = join(home, "workbench");
    mkdirSync(workbenchDir, { recursive: true });
    writeFileSync(join(workbenchDir, "index.html"), "<title>Spcode</title>");
    const plane = new ControlPlane({
      baseDir: home,
      spcodeHome: home,
      workbenchDir,
      port: 0,
      superAgentEnabled: false,
      watchdogEnabled: false,
    });
    cleanups.push(async () => {
      await plane.close().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    });
    const started = await plane.start();
    const origin = `http://127.0.0.1:${started.port}`;
    const bootstrap = await fetch(`${origin}/api/v1/auth/bootstrap`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${started.deviceToken}`,
        Origin: origin,
        "X-Spcode-Control-Client": "1",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    const store = new SqliteSuperAgentStore(join(home, "control.sqlite"));
    const artifact = store.artifacts.put({ kind: "report", content: "private report", mimeType: "text/plain" });
    expect(store.artifacts.read(artifact).toString()).toBe("private report");
    store.close();
    const created = await fetch(`${origin}/api/v1/artifacts/${artifact.id}/share`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "X-Spcode-Control-Client": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ expiresAt: Date.now() + 60_000 }),
    });
    expect(created.status).toBe(200);
    const link = (await created.json()) as { id: string; url: string };
    const publicRead = await fetch(`${origin}${link.url}`);
    expect(publicRead.status).toBe(200);
    const publicBody = await publicRead.text();
    expect(publicBody).toBe("private report");
    const list = await (await fetch(`${origin}/api/v1/share-links`, { headers: { Cookie: cookie } })).json();
    expect(JSON.stringify(list)).not.toContain(link.url);
    expect(JSON.stringify(list)).not.toContain("tokenHash");
    const revoked = await fetch(`${origin}/api/v1/share-links/${link.id}/revoke`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "X-Spcode-Control-Client": "1", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(revoked.status).toBe(200);
    expect((await fetch(`${origin}${link.url}`)).status).toBe(404);

    const expiring = await fetch(`${origin}/api/v1/artifacts/${artifact.id}/share`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "X-Spcode-Control-Client": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ expiresAt: Date.now() + 20 }),
    });
    const expiringLink = (await expiring.json()) as { url: string };
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await fetch(`${origin}${expiringLink.url}`)).status).toBe(404);
  });
});
