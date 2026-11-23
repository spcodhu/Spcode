import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostCommand } from "@spcode/shared";

const role = process.env.SPCODE_WORKER_ROLE;
const workItemId = process.env.SPCODE_WORK_ITEM_ID!;
const worktree = process.env.SPCODE_WORKTREE!;
const home = process.env.SPCODE_HOME!;
const baseSha = process.env.SPCODE_BASE_SHA!;
const sessionFile = join(home, "fake-sessions", `${workItemId}.jsonl`);
let timer: NodeJS.Timeout | null = null;

function respond(command: Extract<HostCommand, { id: string }>, data?: unknown): void {
  process.send?.({ type: "response", id: command.id, success: true, data });
}

async function prompt(command: Extract<HostCommand, { type: "session.prompt" }>): Promise<void> {
  const delay = Number(process.env.SPCODE_FAKE_WORKER_DELAY ?? 0);
  if (process.env.SPCODE_FAKE_WORKER_CRASH === role) process.exit(86);
  if (delay > 0) {
    timer = setInterval(
      () => {
        process.send?.({
          type: "session.event",
          sessionId: workItemId,
          event: { type: "fake_heartbeat", at: Date.now() },
        });
      },
      Math.max(50, Math.min(delay / 4, 1000)),
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  if (role === "plan") {
    const planPath = join(home, "plans", `${workItemId}.md`);
    mkdirSync(join(home, "plans"), { recursive: true });
    writeFileSync(
      planPath,
      `# 计划\n\n基线：${baseSha}\n\n${command.payload.text}\n\n## 验证命令\nnode -e "process.exit(0)"\n\n## 拟改范围\n- superagent-result.md\n\n## 提交与风险\n仅本地 commit；不 push；低风险。\n`,
    );
    process.send?.({ type: "session.plan", sessionId: workItemId, path: planPath });
  } else {
    writeFileSync(
      join(worktree, "superagent-result.md"),
      `# SuperAgent result\n\nWorkItem: ${workItemId}\nBase: ${baseSha}\n`,
    );
    process.send?.({
      type: "session.workReport",
      sessionId: workItemId,
      report: {
        status: "ready",
        summary: "Fake Worker 已在隔离 worktree 写入验收文件",
        tests: [{ command: 'node -e "process.exit(0)"', status: "passed", exitCode: 0 }],
        commitMessage: "功能: 完成 SuperAgent 验收工作项",
      },
    });
  }
  if (timer) clearInterval(timer);
  respond(command, { ok: true });
}

process.on("message", (message: HostCommand) => {
  if (message.type === "shutdown") {
    if (timer) clearInterval(timer);
    process.exit(0);
  }
  if (!("id" in message)) return;
  if (message.type === "session.create" || message.type === "session.open") {
    mkdirSync(join(home, "fake-sessions"), { recursive: true });
    writeFileSync(sessionFile, "{}\n");
    respond(message, {
      sessionId: workItemId,
      sessionFile,
      planMode: "planMode" in message.payload && message.payload.planMode === true,
      running: false,
      permissionMode: "auto",
      sandbox: { state: "disabled" },
      model: null,
      thinkingLevel: "medium",
      supportedThinkingLevels: [],
    });
    return;
  }
  if (message.type === "session.prompt") {
    void prompt(message);
    return;
  }
  respond(message, { ok: true });
});

process.send?.({ type: "ready" });
