import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

const SESSION_ID = "e2e-compaction-context";
const TITLE = "E2E 上下文压缩";
const CWD = mkdtempSync(join(tmpdir(), "spcode-e2e-compaction-"));

function seed(home: string): void {
  const sessionsDir = join(home, "agent", "sessions", "compaction-context");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "session.jsonl");
  writeFileSync(
    join(home, "agent", "auth.json"),
    JSON.stringify({ "kimi-coding": { type: "api_key", key: "e2e-dummy" } }),
  );
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "e2ecompactioncontext",
      timestamp: "2026-02-01T00:00:00.000Z",
      cwd: CWD,
    }),
    JSON.stringify({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-02-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "压缩上下文" }], timestamp: 1769904000000 },
    }),
  ];
  writeFileSync(sessionFile, `${lines.join("\n")}\n`);
  writeFileSync(
    join(home, "sessions.json"),
    JSON.stringify([
      {
        id: SESSION_ID,
        mode: "project",
        cwd: CWD,
        title: TITLE,
        model: null,
        thinkingLevel: "medium",
        sessionFile,
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
  );
}

test("上下文环不被辅助 usage 覆盖，自动/手动压缩只留会话内提示", async () => {
  const app = await launchApp({ seed });
  const window = await app.firstWindow();
  const row = window.locator("div.group", { hasText: TITLE }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();

  await window.evaluate(async () => {
    await window.spcode.command({
      type: "session.setModel",
      payload: { sessionId: "e2e-compaction-context", model: { provider: "kimi-coding", modelId: "k3" } },
    });
  });
  const send = (type: string, payload: Record<string, unknown>) =>
    app.evaluate(
      ({ BrowserWindow }, event) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send("spcode:host-event", event);
      },
      { type, sessionId: SESSION_ID, ...payload },
    );

  await send("session.context", {
    snapshot: { tokens: 120000, contextWindow: 200000, percent: 60, estimated: false },
  });
  const ring = window.getByTestId("context-ring");
  await expect(ring).toHaveAttribute("aria-label", "上下文占用 60%");

  await send("session.usage", {
    usage: {
      sessionId: SESSION_ID,
      model: { provider: "kimi-coding", modelId: "k3" },
      timestamp: Date.now(),
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      costInput: 0,
      costOutput: 0,
      costCacheRead: 0,
      costCacheWrite: 0,
      costTotal: 0,
      source: "distill",
    },
  });
  await expect(ring).toHaveAttribute("aria-label", "上下文占用 60%");

  await send("session.event", {
    event: {
      type: "compaction_end",
      reason: "threshold",
      result: { summary: "自动摘要", tokensBefore: 182000, estimatedTokensAfter: 52000 },
      aborted: false,
      willRetry: false,
    },
  });
  await send("session.context", {
    snapshot: { tokens: 52000, contextWindow: 200000, percent: 26, estimated: true },
  });
  await expect(ring).toHaveAttribute("aria-label", "上下文占用 26%");
  const automatic = window.getByTestId("compaction-notice").last();
  await expect(automatic).toHaveAttribute("data-trigger", "auto");
  await expect(automatic).toContainText("已自动压缩上下文");

  await send("session.event", {
    event: {
      type: "compaction_end",
      reason: "manual",
      result: { summary: "手动摘要", tokensBefore: 50000, estimatedTokensAfter: 10000 },
      aborted: false,
      willRetry: false,
    },
  });
  await send("session.context", {
    snapshot: { tokens: 10000, contextWindow: 200000, percent: 5, estimated: true },
  });
  const manual = window.getByTestId("compaction-notice").last();
  await expect(manual).toHaveAttribute("data-trigger", "manual");
  await expect(manual).toContainText("已手动压缩上下文");
  await expect(window.getByTestId("toast-region")).toHaveCount(0);

  await ring.click();
  await expect(window.getByTestId("compact-now")).toBeEnabled();
  await app.close();
});
