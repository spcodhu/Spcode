import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SourceStore } from "../src/source-store.js";
import { DigestService, GitHubConnector } from "../src/sources/github.js";
import { SqliteSuperAgentStore } from "../src/store-sqlite.js";

function row(id: number, pr = false): Record<string, unknown> {
  return {
    id,
    number: id,
    title: `Issue ${id}`,
    body: "body",
    state: "open",
    user: { login: "octocat" },
    labels: [],
    html_url: `https://github.com/owner/repo/issues/${id}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...(pr ? { pull_request: {} } : {}),
  };
}

describe("GitHubConnector 分页与游标", () => {
  it("多页 open Issue 拉取排除 PR，游标重叠后 contentHash 去重", async () => {
    const calls: string[] = [];
    const connector = new GitHubConnector({
      token: "secret-token",
      fetchImpl: async (input) => {
        const url = new URL(input as string);
        calls.push(url.toString());
        const page = Number(url.searchParams.get("page"));
        const rows =
          page === 1 ? Array.from({ length: 100 }, (_, index) => row(index + 1)) : [row(101, true), row(102)];
        return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    const issues = await connector.listUpdatedOpenIssues("owner/repo", "2026-01-01T00:00:00Z", false);
    expect(issues).toHaveLength(101);
    expect(issues.every((issue) => issue.number !== 101)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("since=2026-01-01T00%3A00%3A00Z");
    expect(calls[0]).not.toContain("secret-token");
  });

  it("每日时间窗口只补最近一次，不重复发同一日摘要", async () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-digest-due-"));
    const base = new SqliteSuperAgentStore(join(home, "control.sqlite"));
    const store = new SourceStore(base.db, base, () => {});
    let now = Date.parse("2026-01-02T10:00:00+08:00");
    const service = new DigestService(store, { listUpdatedOpenIssues: async () => [] }, () => now);
    expect(service.dueDaily("owner/repo", "Asia/Shanghai", "09:00")).toBe(true);
    await service.run({ repo: "owner/repo", chatId: "chat-1", mode: "daily", timezone: "Asia/Shanghai" });
    expect(service.dueDaily("owner/repo", "Asia/Shanghai", "09:00")).toBe(false);
    now = Date.parse("2026-01-03T08:00:00+08:00");
    expect(service.dueDaily("owner/repo", "Asia/Shanghai", "09:00")).toBe(false);
    now = Date.parse("2026-01-03T09:00:00+08:00");
    expect(service.dueDaily("owner/repo", "Asia/Shanghai", "09:00")).toBe(true);
    await service.run({ repo: "owner/repo", chatId: "chat-1", mode: "daily", timezone: "Asia/Shanghai" });
    expect(store.listDigests()).toHaveLength(2);
    base.close();
    rmSync(home, { recursive: true, force: true });
  });
});
