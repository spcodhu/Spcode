import type { EffectProvider, EffectRequestInput, EffectResult } from "@spcode/shared/effect";
import { GitPublisherProvider } from "./providers.js";

export class GitPullRequestProvider implements EffectProvider {
  readonly type = "git.pr" as const;
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async execute(request: EffectRequestInput & { effectId: string; fence: number }): Promise<EffectResult> {
    const push = await new GitPublisherProvider(this.fetchImpl).execute(request);
    if (push.status !== "SUCCEEDED") return push;
    const owner = String(request.input.owner ?? "");
    const repo = String(request.input.repo ?? "");
    const branch = String(request.input.branch ?? "");
    const base = String(request.input.base ?? "main");
    const token = process.env.SPCODE_GITHUB_TOKEN;
    if (!owner || !repo || !branch || !token)
      return { status: "FAILED", evidence: { reason: "PR owner/repo/branch/token 未配置", push } };
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls`;
    const body = {
      title: String(request.input.title ?? `SuperAgent: ${branch}`),
      head: `${owner}:${branch}`,
      base,
      body: String(request.input.body ?? "由 Spcode SuperAgent 创建，不自动 merge。"),
    };
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 201) {
        const created = (await response.json()) as { number: number; html_url: string };
        return {
          status: "SUCCEEDED",
          externalId: created.html_url,
          evidence: { number: created.number, url: created.html_url, push },
        };
      }
      if (response.status === 422) {
        const existing = await this.find(owner, repo, branch, base, token);
        if (existing)
          return { status: "SUCCEEDED", externalId: existing, evidence: { url: existing, existing: true, push } };
      }
      return { status: "FAILED", evidence: { status: response.status, body: await response.text(), push } };
    } catch (error) {
      const existing = await this.find(owner, repo, branch, base, token).catch(() => null);
      return existing
        ? { status: "SUCCEEDED", externalId: existing, evidence: { url: existing, reconciled: true, push } }
        : { status: "UNKNOWN", evidence: { error: error instanceof Error ? error.message : String(error), push } };
    }
  }

  private async find(owner: string, repo: string, branch: string, base: string, token: string): Promise<string | null> {
    const response = await this.fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}&state=all`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return null;
    const rows = (await response.json()) as Array<{ html_url: string }>;
    return rows[0]?.html_url ?? null;
  }
}
