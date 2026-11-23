import { createHash } from "node:crypto";
import type { IssueSnapshot, SourceStore } from "../source-store.js";

export interface GitHubIssueConnector {
  listUpdatedOpenIssues(repo: string, since: string, firstRun: boolean): Promise<IssueSnapshot[]>;
}

export class GitHubConnector implements GitHubIssueConnector {
  constructor(
    private readonly options: {
      token?: string;
      baseUrl?: string;
      fetchImpl?: typeof fetch;
    } = {},
  ) {}

  async listUpdatedOpenIssues(repo: string, since: string, firstRun: boolean): Promise<IssueSnapshot[]> {
    const [owner, name] = repo.split("/");
    if (!owner || !name) throw new Error("GitHub 仓库必须是 owner/repo");
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const base = (this.options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    const issues: IssueSnapshot[] = [];
    for (let page = 1; page <= 5; page++) {
      const url = new URL(`${base}/repos/${owner}/${name}/issues`);
      url.searchParams.set("state", "open");
      url.searchParams.set("sort", "updated");
      url.searchParams.set("direction", "desc");
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      url.searchParams.set("since", since);
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Spcode-SuperAgent",
          ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`GitHub Issues 请求失败：${response.status} ${await response.text()}`);
      const rows = (await response.json()) as Array<Record<string, any>>;
      if (!Array.isArray(rows)) throw new Error("GitHub Issues 响应不是数组");
      for (const row of rows) {
        if (row.pull_request || row.state !== "open") continue;
        const body = typeof row.body === "string" ? row.body : "";
        const labels = Array.isArray(row.labels)
          ? row.labels.map((label: any) => (typeof label === "string" ? label : label?.name)).filter(Boolean)
          : [];
        const contentHash = createHash("sha256")
          .update(JSON.stringify([row.title, body, labels, row.updated_at, row.state]))
          .digest("hex");
        issues.push({
          id: String(row.id),
          number: Number(row.number),
          title: String(row.title ?? ""),
          body,
          author: String(row.user?.login ?? ""),
          labels,
          url: String(row.html_url ?? ""),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
          contentHash,
        });
      }
      if (rows.length < 100 || (firstRun && issues.length >= 50)) break;
    }
    return issues.slice(0, firstRun ? 50 : 500);
  }
}

export class FakeGitHub implements GitHubIssueConnector {
  calls: Array<{ repo: string; since: string; firstRun: boolean }> = [];
  constructor(public issues: IssueSnapshot[]) {}
  async listUpdatedOpenIssues(repo: string, since: string, firstRun: boolean): Promise<IssueSnapshot[]> {
    this.calls.push({ repo, since, firstRun });
    return this.issues
      .filter((issue) => Date.parse(issue.updatedAt) >= Date.parse(since))
      .slice(0, firstRun ? 50 : 500);
  }
}

function localDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export class DigestService {
  constructor(
    readonly store: SourceStore,
    private readonly github: GitHubIssueConnector,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async run(input: {
    repo: string;
    chatId: string;
    mode: "manual" | "daily";
    timezone?: string;
    requestId?: string;
  }): Promise<{ digestId: string; created: boolean; itemCount: number }> {
    const now = this.now();
    const timezone = input.timezone ?? "Asia/Shanghai";
    const date = localDate(new Date(now), timezone);
    const cursor = this.store.cursor(input.repo);
    const firstRun = !cursor.cursor;
    const since = cursor.cursor ?? new Date(now - 24 * 60 * 60_000).toISOString();
    const fetched = await this.github.listUpdatedOpenIssues(input.repo, since, firstRun);
    const issues = fetched.filter((issue) => {
      const existing = this.store.db
        .prepare("SELECT 1 FROM issue_snapshots WHERE repo = ? AND external_id = ? AND content_hash = ?")
        .get(input.repo, issue.id, issue.contentHash);
      return !existing;
    });
    const latest = fetched.reduce((max, issue) => Math.max(max, Date.parse(issue.updatedAt) || 0), 0);
    const nextCursor = new Date(Math.max(latest, now) - 1000).toISOString();
    const scheduleId =
      input.mode === "daily" ? `daily:${input.repo}` : `manual:${input.repo}:${input.requestId ?? crypto.randomUUID()}`;
    const result = this.store.recordDigest({
      scheduleId,
      localDate: input.mode === "daily" ? date : `${date}:${input.requestId ?? "manual"}`,
      configVersion: 1,
      repo: input.repo,
      issues,
      cursor: nextCursor,
      chatId: input.chatId,
    });
    return { ...result, itemCount: issues.length };
  }

  dueDaily(repo: string, timezone: string, dailyTime: string): boolean {
    const now = new Date(this.now());
    const date = localDate(now, timezone);
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);
    if (time < dailyTime) return false;
    const existing = this.store.db
      .prepare("SELECT 1 FROM digest_runs WHERE schedule_id = ? AND local_date = ? AND config_version = 1")
      .get(`daily:${repo}`, date);
    return !existing;
  }
}
