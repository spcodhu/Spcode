import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FakeFeishu } from "../src/integrations/feishu/fake-api.js";
import { ControlPlane } from "../src/server.js";
import { FakeGitHub } from "../src/sources/github.js";
import { SqliteSuperAgentStore } from "../src/store-sqlite.js";
import { NodeWorkerRunner } from "../src/worker-runner.js";

const root = dirname(fileURLToPath(import.meta.url));

describe("阶段一 Issue 与群 @ 完整业务链", () => {
  it("Issue 摘要卡与授权群 @ 都完成计划、批准、commit 和群回执", async () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-business-flow-"));
    const repo = join(home, "repo");
    const workbenchDir = join(home, "workbench");
    mkdirSync(workbenchDir, { recursive: true });
    writeFileSync(join(workbenchDir, "index.html"), "<title>Spcode</title>");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
    const previous = {
      chats: process.env.SPCODE_SUPERAGENT_ALLOWED_CHATS,
      operators: process.env.SPCODE_SUPERAGENT_AUTHORIZED_OPERATORS,
      bot: process.env.SPCODE_FEISHU_BOT_OPEN_ID,
    };
    process.env.SPCODE_SUPERAGENT_ALLOWED_CHATS = "chat-1";
    process.env.SPCODE_SUPERAGENT_AUTHORIZED_OPERATORS = "user-1";
    process.env.SPCODE_FEISHU_BOT_OPEN_ID = "bot-1";
    const feishu = new FakeFeishu();
    const github = new FakeGitHub([
      {
        id: "issue-1",
        number: 7,
        title: "自动闭环",
        body: "通过 Issue 生成工作项",
        author: "octocat",
        labels: ["agent"],
        url: "https://github.com/owner/repo/issues/7",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        contentHash: "issue-v1",
      },
    ]);
    const plane = new ControlPlane({
      baseDir: home,
      spcodeHome: home,
      workbenchDir,
      port: 0,
      superAgentEnabled: true,
      resolveRepoPath: () => repo,
      workerRunner: new NodeWorkerRunner(home, resolve(root, "../src/fake-worker.ts"), { SPCODE_HOME: home }),
      workerPollMs: 20,
      githubConnector: github,
      feishuApi: feishu,
      digestChatId: "chat-1",
      digestSchedulerEnabled: false,
      outboxPollMs: 20,
    });
    const restore = () => {
      for (const [key, value] of Object.entries({
        SPCODE_SUPERAGENT_ALLOWED_CHATS: previous.chats,
        SPCODE_SUPERAGENT_AUTHORIZED_OPERATORS: previous.operators,
        SPCODE_FEISHU_BOT_OPEN_ID: previous.bot,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    try {
      const { port, deviceToken } = await plane.start();
      const origin = `http://127.0.0.1:${port}`;
      const bootstrap = await fetch(`${origin}/api/v1/auth/bootstrap`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deviceToken}`,
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
          headers: {
            Cookie: cookie,
            Origin: origin,
            "X-Spcode-Control-Client": "1",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      const snapshot = async () => {
        const response = await fetch(`${origin}/api/v1/superagent/snapshot`, { headers: { Cookie: cookie } });
        return response.json();
      };
      const waitFor = async (check: () => boolean | Promise<boolean>, label: string) => {
        const deadline = Date.now() + 12_000;
        while (!(await check())) {
          if (Date.now() > deadline) throw new Error(`等待超时：${label}; ${JSON.stringify(feishu.messages)}`);
          await new Promise((resolveWait) => setTimeout(resolveWait, 30));
        }
      };
      const actionValues = (message: { content: unknown }) =>
        (message.content as { elements: Array<{ actions?: Array<{ value: Record<string, any> }> }> }).elements
          .flatMap((element) => element.actions ?? [])
          .map((action) => action.value);

      expect((await command({ type: "digest.run", repo: "owner/repo", requestId: "digest-business" })).status).toBe(
        200,
      );
      await waitFor(() => feishu.messages.some((message) => message.kind === "card"), "Issue 摘要卡");
      const digestMessage = feishu.messages.find((message) => message.kind === "card")!;
      const digestAction = actionValues(digestMessage).find((value) => value.action === "digest.trigger")!;
      await feishu.emitCard({
        eventId: "digest-card-event",
        operatorOpenId: "user-1",
        chatId: "chat-1",
        messageId: digestMessage.messageId,
        value: digestAction,
      });
      await waitFor(() => feishu.messages.filter((message) => message.kind === "card").length >= 2, "Issue 计划卡");
      let state = await snapshot();
      expect(state.workItems).toHaveLength(1);
      expect(state.workItems[0].status).toBe("AWAITING_PLAN_APPROVAL");
      const issuePlanMessage = feishu.messages.filter((message) => message.kind === "card")[1]!;
      const issuePlanAction = actionValues(issuePlanMessage).find((value) => value.action === "plan.approve")!;
      await feishu.emitCard({
        eventId: "issue-plan-approval",
        operatorOpenId: "user-1",
        chatId: "chat-1",
        messageId: issuePlanMessage.messageId,
        value: issuePlanAction,
      });
      await waitFor(async () => (await snapshot()).workItems[0]?.status === "COMPLETED", "Issue commit");

      const groupMessage = {
        eventId: "group-event-1",
        messageId: "group-message-1",
        chatId: "chat-1",
        chatType: "group" as const,
        operatorOpenId: "user-1",
        text: "@_user_1 owner/repo 从群消息创建第二个任务",
        mentions: [{ openId: "bot-1", name: "Spcode", key: "@_user_1" }],
        fromBot: false,
      };
      await feishu.emitMessage(groupMessage);
      await feishu.emitMessage(groupMessage);
      await waitFor(() => feishu.messages.filter((message) => message.kind === "card").length >= 3, "群任务计划卡");
      state = await snapshot();
      expect(state.workItems).toHaveLength(2);
      expect(feishu.messages.filter((message) => message.kind === "reply")).toHaveLength(1);
      const groupPlanMessage = feishu.messages.filter((message) => message.kind === "card")[2]!;
      const groupPlanAction = actionValues(groupPlanMessage).find((value) => value.action === "plan.approve")!;
      await feishu.emitCard({
        eventId: "group-plan-approval",
        operatorOpenId: "user-1",
        chatId: "chat-1",
        messageId: groupPlanMessage.messageId,
        value: groupPlanAction,
      });
      await waitFor(async () => {
        const current = await snapshot();
        return (
          current.workItems.length === 2 &&
          current.workItems.every((item: { status: string }) => item.status === "COMPLETED")
        );
      }, "群任务 commit");

      state = await snapshot();
      for (const item of state.workItems) {
        expect(item.commitSha).toMatch(/^[0-9a-f]{40}$/);
        expect(
          execFileSync("git", ["rev-list", "--count", `${item.baseSha}..HEAD`], {
            cwd: item.worktreePath,
            encoding: "utf8",
          }).trim(),
        ).toBe("1");
      }
      await waitFor(
        async () => (await snapshot()).outbox.every((item: { status: string }) => item.status === "SENT"),
        "Outbox 全部 SENT",
      );
      expect(
        feishu.messages.filter((message) => message.kind === "text" && String(message.content).includes("本地 commit"))
          .length,
      ).toBe(2);
      await plane.close();
      const db = new SqliteSuperAgentStore(join(home, "control.sqlite"));
      expect(Number(db.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n)).toBe(2);
      expect(Number(db.db.prepare("SELECT COUNT(*) AS n FROM work_items").get()!.n)).toBe(2);
      db.close();
    } finally {
      await plane.close().catch(() => {});
      restore();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
