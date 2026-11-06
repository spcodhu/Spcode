import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

const SESSION_ID = "e2e-markdown-code-block";
const TITLE = "代码块布局";
const CWD = mkdtempSync(join(tmpdir(), "spcode-e2e-code-block-"));

function seed(home: string): void {
  const sessionsDir = join(home, "agent", "sessions", "-tmp-spcode-e2e-code-block");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "e2emarkdowncodeblock",
      timestamp: "2026-02-01T00:00:00.000Z",
      cwd: CWD,
    }),
    JSON.stringify({
      type: "message",
      id: "a1",
      parentId: null,
      timestamp: "2026-02-01T00:00:01.000Z",
      message: {
        role: "assistant",
        timestamp: 1769904001000,
        content: [
          {
            type: "text",
            text: "下面是一段代码：\n\n```tsx\nexport function Hello() {\n  return <strong>Hello, Spcode!</strong>;\n}\n```",
          },
        ],
      },
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

test("代码块复制按钮与语言标签在标题栏内垂直居中", async ({}, testInfo) => {
  const app = await launchApp({ seed });
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1280, height: 840 });
  await window.locator("div.group", { hasText: TITLE }).first().click();

  const codeBlock = window.locator('[data-streamdown="code-block"]');
  const copyButton = window.locator('[data-streamdown="code-block-copy-button"]');
  await expect(copyButton).toBeVisible({ timeout: 15000 });
  await codeBlock.screenshot({ path: testInfo.outputPath("code-block.png") });

  const label = window.locator('[data-streamdown="code-block-header"] span');
  const labelBox = await label.boundingBox();
  const buttonBox = await copyButton.boundingBox();
  expect(labelBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  const labelCenter = labelBox!.y + labelBox!.height / 2;
  const buttonCenter = buttonBox!.y + buttonBox!.height / 2;
  expect(Math.abs(labelCenter - buttonCenter)).toBeLessThanOrEqual(1);

  await app.close();
});
