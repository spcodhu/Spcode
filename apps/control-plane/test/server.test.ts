import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { readRuntimeInfo } from "../src/discovery.js";
import { ControlPlane } from "../src/server.js";
import { SqliteSuperAgentStore } from "../src/store-sqlite.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "spcode-server-test-"));
  const workbenchDir = join(home, "workbench");
  mkdirSync(workbenchDir, { recursive: true });
  writeFileSync(join(workbenchDir, "index.html"), "<!doctype html><title>Spcode test</title><div id='root'></div>");
  let plane = new ControlPlane({ baseDir: home, workbenchDir, port: 0 });
  const { port, deviceToken } = await plane.start();
  cleanups.push(async () => {
    await plane.close().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  const bootstrapResponse = await fetch(`${origin}/api/v1/auth/bootstrap`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deviceToken}`,
      Origin: origin,
      "X-Spcode-Control-Client": "1",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const cookie = bootstrapResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
  return {
    home,
    origin,
    deviceToken,
    cookie,
    get plane() {
      return plane;
    },
    async restart() {
      await plane.close();
      plane = new ControlPlane({ baseDir: home, workbenchDir, port: 0 });
      const next = await plane.start();
      return next.port;
    },
  };
}

function mutationHeaders(origin: string, cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    Origin: origin,
    "Content-Type": "application/json",
    "X-Spcode-Control-Client": "1",
  };
}

const createCommand = {
  type: "workitem.create",
  requestId: "req_server_1",
  repo: "spcodhu/Spcode",
  title: "HTTP 集成",
  request: "验证持久化与认证",
};

describe("Headless 控制面 HTTP / WSS", () => {
  it("静态页公开，API 必须认证；Host、Origin 和 CSRF 失败关闭", async () => {
    const app = await fixture();
    const page = await fetch(app.origin);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Spcode test");
    expect((await fetch(`${app.origin}/api/v1/superagent/snapshot`)).status).toBe(401);
    const hostileHostStatus = await new Promise<number>((resolve, reject) => {
      const url = new URL(app.origin);
      const req = request(
        {
          hostname: url.hostname,
          port: url.port,
          path: "/api/v1/health",
          headers: { Host: "evil.example" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      req.once("error", reject);
      req.end();
    });
    expect(hostileHostStatus).toBe(403);
    const rejected = await fetch(`${app.origin}/api/v1/superagent/commands`, {
      method: "POST",
      headers: { ...mutationHeaders(app.origin, app.cookie), Origin: "https://evil.example" },
      body: JSON.stringify(createCommand),
    });
    expect(rejected.status).toBe(403);
    const accepted = await fetch(`${app.origin}/api/v1/superagent/commands`, {
      method: "POST",
      headers: mutationHeaders(app.origin, app.cookie),
      body: JSON.stringify(createCommand),
    });
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).workItems).toHaveLength(1);
  });

  it("认证会话跨服务重启有效，SuperAgent 快照不丢", async () => {
    const app = await fixture();
    await fetch(`${app.origin}/api/v1/superagent/commands`, {
      method: "POST",
      headers: mutationHeaders(app.origin, app.cookie),
      body: JSON.stringify(createCommand),
    });
    const port = await app.restart();
    const origin = `http://127.0.0.1:${port}`;
    const response = await fetch(`${origin}/api/v1/superagent/snapshot`, {
      headers: { Cookie: app.cookie },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).workItems[0].title).toBe("HTTP 集成");
  });

  it("WSS 只发变化提示，桌面适配器复用同一命令响应通道", async () => {
    const app = await fixture();
    const runtime = readRuntimeInfo(app.home)!;
    const desktop = new WebSocket(`ws://127.0.0.1:${runtime.port}/api/v1/desktop`, {
      headers: { Authorization: `Bearer ${runtime.serviceToken}` },
    });
    await new Promise<void>((resolve, reject) => {
      desktop.once("open", () => resolve());
      desktop.once("error", reject);
    });
    cleanups.push(() => desktop.close());
    const browser = new WebSocket(`ws://127.0.0.1:${runtime.port}/api/v1/events`, {
      headers: { Cookie: app.cookie, Origin: app.origin },
    });
    const events: Array<{ type: string; sequence?: number; event?: { type: string } }> = [];
    browser.on("message", (data) => events.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      browser.once("open", () => resolve());
      browser.once("error", reject);
    });
    cleanups.push(() => browser.close());

    desktop.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "desktop.invoke") {
        desktop.send(
          JSON.stringify({ type: "desktop.response", id: message.id, ok: true, result: { echoed: message.method } }),
        );
      }
    });
    const response = await fetch(`${app.origin}/api/v1/desktop/invoke`, {
      method: "POST",
      headers: mutationHeaders(app.origin, app.cookie),
      body: JSON.stringify({ method: "listSessions", args: [] }),
    });
    expect((await response.json()).result).toEqual({ echoed: "listSessions" });

    desktop.send(JSON.stringify({ type: "desktop.event", event: { type: "sessions.changed" } }));
    await fetch(`${app.origin}/api/v1/superagent/commands`, {
      method: "POST",
      headers: mutationHeaders(app.origin, app.cookie),
      body: JSON.stringify(createCommand),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.some((event) => event.type === "host.event" && event.event?.type === "sessions.changed")).toBe(true);
    expect(events.some((event) => event.type === "superagent.changed" && Number(event.sequence) > 0)).toBe(true);
  });

  it("设备令牌文件不进入 runtime.json，权限保持 0600", async () => {
    const app = await fixture();
    const runtimeRaw = readFileSync(join(app.home, "runtime.json"), "utf8");
    expect(runtimeRaw).not.toContain(app.deviceToken);
    expect(runtimeRaw).toContain("serviceToken");
    if (process.platform !== "win32") {
      expect(statSync(join(app.home, "runtime.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(app.home, "device-token")).mode & 0o777).toBe(0o600);
    }
  });

  it("Artifact 匿名访问失败，认证后可按原内容下载", async () => {
    const app = await fixture();
    const store = new SqliteSuperAgentStore(join(app.home, "control.sqlite"));
    const artifact = store.artifacts.put({ kind: "diff", content: "diff --git a/a b/a\n", mimeType: "text/x-diff" });
    store.close();
    const anonymous = await fetch(`${app.origin}/api/v1/artifacts/${artifact.id}`);
    expect(anonymous.status).toBe(401);
    const response = await fetch(`${app.origin}/api/v1/artifacts/${artifact.id}`, { headers: { Cookie: app.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(await response.text()).toBe("diff --git a/a b/a\n");
  });
});
