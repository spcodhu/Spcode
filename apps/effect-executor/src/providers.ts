import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGit } from "@spcode/control-plane/git-workspace";
import type { EffectProvider, EffectRequestInput, EffectResult } from "@spcode/shared/effect";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (executable: string, args: string[], cwd?: string) => Promise<CommandResult>;

export const execRunner: CommandRunner = (executable, args, cwd) =>
  new Promise((resolve) => {
    execFile(executable, args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code:
          typeof (error as { code?: unknown } | null)?.code === "number"
            ? (error as unknown as { code: number }).code
            : error
              ? 1
              : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });

function result(
  status: EffectResult["status"],
  evidence: Record<string, unknown>,
  externalId?: string,
  retryable?: boolean,
): EffectResult {
  return { status, evidence, ...(externalId ? { externalId } : {}), ...(retryable === undefined ? {} : { retryable }) };
}

function stringInput(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Effect input.${key} 必填`);
  return value.trim();
}

export class NginxProvider implements EffectProvider {
  readonly type = "nginx.reload" as const;
  constructor(private readonly runner: CommandRunner = execRunner) {}
  async execute(request: EffectRequestInput & { effectId: string; fence: number }): Promise<EffectResult> {
    const config = stringInput(request.input, "config");
    const target = resolve(stringInput(request.input, "targetPath"));
    const root = resolve(process.env.SPCODE_NGINX_ROOT ?? "/etc/nginx");
    if (target !== root && !target.startsWith(`${root}/`))
      return result("FAILED", { reason: "target outside allowlist" });
    const temp = mkdtempSync(join(tmpdir(), "spcode-nginx-"));
    try {
      const candidate = join(temp, "nginx.conf");
      writeFileSync(candidate, config, { mode: 0o600 });
      const check = await this.runner("nginx", ["-t", "-q", "-c", candidate], temp);
      if (check.code !== 0) return result("FAILED", { validated: false, output: check.stderr || check.stdout });
      if (request.input.reload === true) {
        writeFileSync(target, config, { mode: 0o600 });
        const reload = await this.runner("nginx", ["-s", "reload"], temp);
        if (reload.code !== 0)
          return result("UNKNOWN", { validated: true, reload: false, output: reload.stderr || reload.stdout });
      }
      return result("SUCCEEDED", { validated: true, reloaded: request.input.reload === true, targetPath: target });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
}

export class DeploymentProvider implements EffectProvider {
  readonly type = "deployment.apply" as const;
  constructor(private readonly runner: CommandRunner = execRunner) {}
  async execute(request: EffectRequestInput & { effectId: string; fence: number }): Promise<EffectResult> {
    const file = resolve(stringInput(request.input, "composeFile"));
    const root = resolve(process.env.SPCODE_DEPLOYMENT_ROOT ?? process.cwd());
    const service = stringInput(request.input, "service");
    if ((file !== root && !file.startsWith(`${root}/`)) || !/^[a-zA-Z0-9_.-]+$/.test(service))
      return result("FAILED", { reason: "compose file/service outside allowlist" });
    const output = await this.runner("docker", ["compose", "-f", file, "up", "-d", service], root);
    return output.code === 0
      ? result("SUCCEEDED", { service, output: output.stdout }, service)
      : result("FAILED", { service, output: output.stderr || output.stdout });
  }
}

export class DnsProvider implements EffectProvider {
  readonly type = "dns.upsert" as const;
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}
  async execute(request: EffectRequestInput & { effectId: string; fence: number }): Promise<EffectResult> {
    const token = process.env.SPCODE_CLOUDFLARE_API_TOKEN;
    if (!token) return result("FAILED", { reason: "SPCODE_CLOUDFLARE_API_TOKEN 未配置" });
    const zoneId = stringInput(request.input, "zoneId");
    const record = request.input.record as {
      type?: string;
      name?: string;
      content?: string;
      ttl?: number;
      proxied?: boolean;
    };
    if (!record?.type || !record.name || !record.content) return result("FAILED", { reason: "DNS record 不完整" });
    const base = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/dns_records`;
    try {
      const existing = await this.fetchImpl(
        `${base}?type=${encodeURIComponent(record.type)}&name=${encodeURIComponent(record.name)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!existing.ok) return result("FAILED", { status: existing.status, body: await existing.text() });
      const rows = (await existing.json()) as { result?: Array<{ id: string }> };
      const current = rows.result?.[0];
      const response = await this.fetchImpl(current ? `${base}/${current.id}` : base, {
        method: current ? "PUT" : "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          type: record.type,
          name: record.name,
          content: record.content,
          ttl: record.ttl ?? 300,
          proxied: record.proxied === true,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return result("FAILED", { status: response.status, body: await response.text() });
      const body = (await response.json()) as { result?: { id?: string } };
      return result("SUCCEEDED", { updated: !!current, zoneId }, body.result?.id);
    } catch (error) {
      return result("UNKNOWN", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export class GitPublisherProvider implements EffectProvider {
  readonly type = "git.push" as const;
  constructor(readonly _fetchImpl: typeof fetch = fetch) {}
  async execute(request: EffectRequestInput & { effectId: string; fence: number }): Promise<EffectResult> {
    const worktree = stringInput(request.input, "worktreePath");
    const branch = stringInput(request.input, "branch");
    const commitSha = stringInput(request.input, "commitSha");
    const remote = typeof request.input.remote === "string" ? request.input.remote : "origin";
    if (!/^superagent\/[A-Za-z0-9_-]+$/.test(branch) || !/^[0-9a-f]{40}$/.test(commitSha))
      return result("FAILED", { reason: "branch/commit outside publisher policy" });
    const head = await runGit(["rev-parse", "HEAD"], worktree);
    if (head.stdout.trim() !== commitSha) return result("FAILED", { reason: "commitSha 与实际 HEAD 不一致" });
    const remoteBefore = await runGit(["ls-remote", "--heads", remote, branch], worktree);
    const remoteSha = remoteBefore.stdout.split(/\s+/)[0];
    if (remoteSha) {
      const ancestor = await runGit(["merge-base", "--is-ancestor", remoteSha, commitSha], worktree);
      if (ancestor.code !== 0) return result("FAILED", { reason: "non-fast-forward，拒绝 push", remoteSha });
    }
    const pushed = await runGit(["push", "--porcelain", remote, branch], worktree);
    if (pushed.code !== 0) {
      const remoteAfter = await runGit(["ls-remote", "--heads", remote, branch], worktree);
      const afterSha = remoteAfter.stdout.split(/\s+/)[0];
      if (afterSha === commitSha) return result("SUCCEEDED", { reconciled: true, remoteSha: afterSha }, commitSha);
      return result("UNKNOWN", { output: pushed.stderr || pushed.stdout, remoteSha: afterSha });
    }
    return result("SUCCEEDED", { remoteSha: commitSha, branch }, commitSha);
  }
}

export class ArtifactReportProvider implements EffectProvider {
  readonly type = "artifact.report" as const;
  constructor(private readonly upload: (body: string, effectId: string, fence: number) => Promise<string>) {}
  async execute(request: EffectRequestInput & { effectId: string; fence: number }): Promise<EffectResult> {
    const artifactId = await this.upload(
      JSON.stringify({ workItemId: request.workItemId, resource: request.resource, input: request.input }, null, 2),
      request.effectId,
      request.fence,
    );
    return result("SUCCEEDED", { artifactId }, artifactId);
  }
}

export class SystemExecProvider implements EffectProvider {
  readonly type = "system.exec" as const;
  constructor(private readonly runner: CommandRunner = execRunner) {}
  async execute(request: EffectRequestInput & { effectId: string; fence: number }): Promise<EffectResult> {
    const executable = stringInput(request.input, "executable");
    const allowed = new Set(["printf", "date", "uname", "git"]);
    if (!allowed.has(executable)) return result("FAILED", { reason: "system.exec executable outside allowlist" });
    const args = request.input.args;
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || /[;&|><$`]/.test(arg)))
      return result("FAILED", { reason: "system.exec args invalid" });
    const output = await this.runner(executable, args as string[]);
    return output.code === 0
      ? result("SUCCEEDED", { output: output.stdout })
      : result("FAILED", { output: output.stderr || output.stdout });
  }
}
