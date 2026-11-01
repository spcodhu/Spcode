import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

const SESSION_ID = "e2e-usage-history";
const TITLE = "E2E 历史用量";
const CWD = mkdtempSync(join(tmpdir(), "spcode-e2e-usage-history-"));

function seedUsage(home: string): void {
  mkdirSync(CWD, { recursive: true });
  const sessionsDir = join(home, "agent", "sessions", "-tmp-spcode-e2e-usage-history");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "e2eusagehistory",
      timestamp: "2026-02-01T00:00:00.000Z",
      cwd: CWD,
    }),
    JSON.stringify({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-02-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "历史用量" }], timestamp: 1769904000000 },
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

  const usageDir = join(home, "usage");
  mkdirSync(usageDir, { recursive: true });
  const record = {
    sessionId: SESSION_ID,
    model: { provider: "kimi-coding", modelId: "k3" },
    timestamp: Date.now(),
    input: 1_000_000,
    output: 200_000,
    cacheRead: 300_000,
    cacheWrite: 50_000,
    costInput: 1,
    costOutput: 0.2,
    costCacheRead: 0.03,
    costCacheWrite: 0.02,
    costTotal: 1.25,
    costBasis: "engine",
  };
  writeFileSync(join(usageDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`);
}

test("历史会话从账本恢复用量，新会话零用量也不隐藏 chip", async () => {
  const app = await launchApp({ seed: seedUsage });
  const window = await app.firstWindow();
  const row = window.locator("div.group", { hasText: TITLE }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();

  const chip = window.getByTestId("session-usage-chip");
  await expect(chip).toBeVisible({ timeout: 15000 });
  await expect(chip).toContainText("1.6M");
  await expect(chip).toContainText("23%");
  await expect(chip).toContainText("$1.2500");

  await window.getByTestId("sidebar-new-chat").click();
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("$0.0000");
  await app.close();
});

test("模型四项单价可保存并恢复默认，不回写历史账本", async () => {
  const spcodeHome = mkdtempSync(join(tmpdir(), "spcode-e2e-pricing-"));
  const app = await launchApp({ spcodeHome });
  const window = await app.firstWindow();
  await window.getByTestId("sidebar-settings").click();
  await window.getByRole("button", { name: "模型", exact: true }).click();
  await window.getByTestId("provider-open").first().click();

  const pricingToggle = window.getByTestId("model-pricing-toggle").first();
  await expect(pricingToggle).toBeVisible({ timeout: 20000 });
  const modelKey = await pricingToggle.getAttribute("data-model");
  expect(modelKey).toBeTruthy();
  await pricingToggle.click();
  await window.getByTestId("model-price-input").fill("2.5");
  await window.getByTestId("model-price-output").fill("12");
  await window.getByTestId("model-price-cacheRead").fill("0.25");
  await window.getByTestId("model-price-cacheWrite").fill("5");
  await window.getByTestId("model-pricing-save").click();

  const settingsPath = join(spcodeHome, "settings.json");
  await expect.poll(() => JSON.parse(readFileSync(settingsPath, "utf-8")).modelPricing?.[modelKey!]?.input).toBe(2.5);
  const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
  expect(saved.modelPricing[modelKey!]).toEqual({ input: 2.5, output: 12, cacheRead: 0.25, cacheWrite: 5 });

  await window.getByTestId("model-pricing-reset").click();
  await expect.poll(() => JSON.parse(readFileSync(settingsPath, "utf-8")).modelPricing?.[modelKey!]).toBeUndefined();
  await app.close();
});
