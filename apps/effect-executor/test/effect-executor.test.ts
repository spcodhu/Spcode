import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EffectRequestInput, effectInputHash } from "@spcode/shared/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlane } from "../../control-plane/src/server.js";
import {
  ArtifactReportProvider,
  DeploymentProvider,
  DnsProvider,
  GitPublisherProvider,
  NginxProvider,
} from "../src/providers.js";
import { HttpEffectExecutor } from "../src/remote.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "spcode-effect-http-"));
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
  const command = (body: unknown) =>
    fetch(`${origin}/api/v1/superagent/commands`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "X-Spcode-Control-Client": "1", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  await command({
    type: "workitem.create",
    requestId: "req_effect_http",
    repo: "owner/repo",
    title: "Effect HTTP",
    request: "执行 Provider",
  });
  await command({
    type: "plan.submit",
    workItemId: (await (await fetch(`${origin}/api/v1/superagent/snapshot`, { headers: { Cookie: cookie } })).json())
      .workItems[0].id,
    content: "计划",
    baseSha: "abc",
    verification: ["pnpm test"],
    changeScope: ["src/**"],
    publishIntent: true,
    effectIntent: ["artifact.report", "nginx.reload", "deployment.apply", "dns.upsert", "git.push"],
  });
  const state = await (await fetch(`${origin}/api/v1/superagent/snapshot`, { headers: { Cookie: cookie } })).json();
  const item = state.workItems[0];
  const plan = state.plans[0];
  await command({ type: "plan.approve", workItemId: item.id, planId: plan.id, planHash: plan.planHash });
  const request = async (input: EffectRequestInput) => {
    const response = await fetch(`${origin}/api/v1/effects/request`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "X-Spcode-Control-Client": "1", "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    return (await response.json()).id as string;
  };
  const approve = async (effectId: string, input: EffectRequestInput) => {
    const response = await fetch(`${origin}/api/v1/effects/approve`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "X-Spcode-Control-Client": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ effectId, inputHash: createHash("sha256").update(effectInputHash(input)).digest("hex") }),
    });
    expect(response.status).toBe(200);
  };
  const list = async () =>
    (await (await fetch(`${origin}/api/v1/effects`, { headers: { Cookie: cookie } })).json()).effects;
  process.env.SPCODE_EXECUTOR_TOKEN = "executor-test-token";
  cleanups.push(() => {
    delete process.env.SPCODE_EXECUTOR_TOKEN;
  });
  return { home, origin, cookie, item, plan, request, approve, list };
}

describe("真实 HTTP Effect Executor", () => {
  it("Artifact/Report 通过 Executor 上传并成为 SUCCEEDED", async () => {
    const app = await fixture();
    const input: EffectRequestInput = {
      workItemId: app.item.id,
      planHash: app.plan.planHash,
      expectedRevision: app.plan.revision,
      type: "artifact.report",
      resource: "report/test",
      input: { title: "测试报告" },
      idempotencyKey: "artifact-report-1",
    };
    const effectId = await app.request(input);
    await app.approve(effectId, input);
    const executor = new HttpEffectExecutor(
      app.origin,
      "executor-test-token",
      "executor-1",
      new Map([
        [
          "artifact.report",
          new ArtifactReportProvider(async (body, effectId, fence) => {
            const response = await fetch(`${app.origin}/api/v1/effect-artifacts`, {
              method: "POST",
              headers: {
                Authorization: "Bearer executor-test-token",
                "X-Spcode-Control-Client": "1",
                "Content-Type": "application/json",
                "X-Spcode-Effect-Id": effectId,
                "X-Spcode-Fence": String(fence),
              },
              body,
            });
            return (await response.json()).id as string;
          }),
        ],
      ]),
    );
    expect(await executor.tick()).toBe(true);
    const effect = (await app.list()).find((item: { id: string }) => item.id === effectId);
    expect(effect.status).toBe("SUCCEEDED");
    expect(effect.externalId).toMatch(/^ar_/);
    executor.stop();
  });

  it("Executor 回执前异常进入 UNKNOWN 且不重复执行", async () => {
    const app = await fixture();
    const input: EffectRequestInput = {
      workItemId: app.item.id,
      planHash: app.plan.planHash,
      expectedRevision: app.plan.revision,
      type: "artifact.report",
      resource: "report/crash",
      input: { title: "崩溃报告" },
      idempotencyKey: "artifact-crash",
    };
    const effectId = await app.request(input);
    await app.approve(effectId, input);
    let calls = 0;
    const provider = {
      type: "artifact.report" as const,
      execute: async () => {
        calls++;
        throw new Error("after-side-effect-crash");
      },
    };
    const executor = new HttpEffectExecutor(
      app.origin,
      "executor-test-token",
      "executor-1",
      new Map([["artifact.report", provider]]),
    );
    expect(await executor.tick()).toBe(true);
    expect((await app.list()).find((item: { id: string }) => item.id === effectId).status).toBe("UNKNOWN");
    expect(await executor.tick()).toBe(false);
    expect(calls).toBe(1);
    executor.stop();
  });

  it("Nginx 非法配置失败，Deployment 与 DNS 成功分别落真实结果", async () => {
    const app = await fixture();
    const nginxRoot = join(app.home, "nginx");
    process.env.SPCODE_NGINX_ROOT = nginxRoot;
    const nginxInput: EffectRequestInput = {
      workItemId: app.item.id,
      planHash: app.plan.planHash,
      expectedRevision: app.plan.revision,
      type: "nginx.reload",
      resource: "local/nginx",
      input: { config: "not valid nginx", targetPath: join(nginxRoot, "nginx.conf"), reload: false },
      idempotencyKey: "nginx-failed",
    };
    const nginxId = await app.request(nginxInput);
    await app.approve(nginxId, nginxInput);
    const nginx = new HttpEffectExecutor(
      app.origin,
      "executor-test-token",
      "executor-1",
      new Map([["nginx.reload", new NginxProvider(async () => ({ code: 1, stdout: "", stderr: "syntax error" }))]]),
    );
    await nginx.tick();
    expect((await app.list()).find((item: { id: string }) => item.id === nginxId).status).toBe("FAILED");

    const compose = join(app.home, "compose.yml");
    process.env.SPCODE_DEPLOYMENT_ROOT = app.home;
    writeFileSync(compose, "services: {}\n");
    const deployInput: EffectRequestInput = {
      ...nginxInput,
      type: "deployment.apply",
      resource: "local/deploy",
      input: { composeFile: compose, service: "app" },
      idempotencyKey: "deploy-ok",
    };
    const deployId = await app.request(deployInput);
    await app.approve(deployId, deployInput);
    const deploy = new HttpEffectExecutor(
      app.origin,
      "executor-test-token",
      "executor-1",
      new Map([["deployment.apply", new DeploymentProvider(async () => ({ code: 0, stdout: "started", stderr: "" }))]]),
    );
    await deploy.tick();
    expect((await app.list()).find((item: { id: string }) => item.id === deployId).status).toBe("SUCCEEDED");

    const dnsInput: EffectRequestInput = {
      ...nginxInput,
      type: "dns.upsert",
      resource: "cloudflare/zone",
      input: { zoneId: "zone-1", record: { type: "A", name: "agent.example.com", content: "127.0.0.1" } },
      idempotencyKey: "dns-ok",
    };
    const dnsId = await app.request(dnsInput);
    await app.approve(dnsId, dnsInput);
    process.env.SPCODE_CLOUDFLARE_API_TOKEN = "dns-token";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ result: { id: "record-1" } }), { status: 200 });
      return new Response(JSON.stringify({ result: [] }), { status: 200 });
    });
    const dns = new HttpEffectExecutor(
      app.origin,
      "executor-test-token",
      "executor-1",
      new Map([["dns.upsert", new DnsProvider(fetchMock as typeof fetch)]]),
    );
    await dns.tick();
    expect((await app.list()).find((item: { id: string }) => item.id === dnsId).status).toBe("SUCCEEDED");
    delete process.env.SPCODE_CLOUDFLARE_API_TOKEN;
    delete process.env.SPCODE_DEPLOYMENT_ROOT;
    delete process.env.SPCODE_NGINX_ROOT;
    nginx.stop();
    deploy.stop();
    dns.stop();
  });

  it("本地 bare Git 只允许 fast-forward push，不产生第二次 push", async () => {
    const app = await fixture();
    const remote = join(app.home, "remote.git");
    const worktree = join(app.home, "worktree");
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["clone", remote, worktree]);
    execFileSync("git", ["config", "user.name", "Test"], { cwd: worktree });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: worktree });
    writeFileSync(join(worktree, "result.txt"), "result\n");
    execFileSync("git", ["add", "result.txt"], { cwd: worktree });
    execFileSync("git", ["commit", "-m", "init"], { cwd: worktree });
    execFileSync("git", ["checkout", "-b", "superagent/test"], { cwd: worktree });
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
    const input: EffectRequestInput = {
      workItemId: app.item.id,
      planHash: app.plan.planHash,
      expectedRevision: app.plan.revision,
      type: "git.push",
      resource: "owner/repo",
      input: { worktreePath: worktree, branch: "superagent/test", commitSha, remote: "origin" },
      idempotencyKey: "push-1",
    };
    const effectId = await app.request(input);
    await app.approve(effectId, input);
    const executor = new HttpEffectExecutor(
      app.origin,
      "executor-test-token",
      "executor-1",
      new Map([["git.push", new GitPublisherProvider()]]),
    );
    expect(await executor.tick()).toBe(true);
    expect((await app.list()).find((item: { id: string }) => item.id === effectId).status).toBe("SUCCEEDED");
    expect(
      execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/superagent/test"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(commitSha);
    expect(await executor.tick()).toBe(false);
    executor.stop();
  }, 30_000);
});
