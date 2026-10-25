import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { launchApp } from "./helpers";

async function chooseLanguage(page: Page, locale: "zh-CN" | "en") {
  const group = page.getByTestId("settings-language");
  await group.getByRole("button").click();
  const label = locale === "en" ? /English|英语/ : /简体中文|Simplified Chinese/;
  await group.getByRole("option", { name: label }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
}

test("language selector updates all settings pages and survives restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "spcode-locale-e2e-"));
  let app = await launchApp({ spcodeHome: home });
  try {
    let page = await app.firstWindow();
    await expect(page.getByTestId("brand")).toBeVisible({ timeout: 15000 });
    await page.keyboard.press("Meta+Comma");
    await chooseLanguage(page, "en");
    for (const section of ["general", "appearance", "models", "usage", "quota", "remote", "mcp", "memory", "about"]) {
      await page.getByTestId(`settings-nav-${section}`).click();
      await expect(page.locator("body")).not.toContainText(/[\u4e00-\u9fff]/);
    }
    await page.keyboard.press("Escape");
    await expect(page.locator("body")).not.toContainText(/[\u4e00-\u9fff]/);
    await app.close();
    app = await launchApp({ spcodeHome: home });
    page = await app.firstWindow();
    await expect(page.getByTestId("brand")).toBeVisible({ timeout: 15000 });
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.keyboard.press("Meta+Comma");
    await chooseLanguage(page, "zh-CN");
    await expect(page.getByTestId("settings-nav-general")).toHaveText("通用");
    await expect(page.getByTestId("settings-language").getByRole("button").first()).toHaveText("简体中文");
  } finally {
    await app.close();
  }
});

test("English run-error cards keep the raw provider error and localize only app copy", async () => {
  const cwd = "/tmp/spcode-e2e-i18n-error";
  const raw = "Error: EPERM: operation not permitted, open '/tmp/x'";
  const app = await launchApp({
    seed: (home) => {
      mkdirSync(cwd, { recursive: true });
      const sessionsDir = join(home, "agent", "sessions", "-tmp-spcode-e2e-i18n-error");
      mkdirSync(sessionsDir, { recursive: true });
      const sessionFile = join(sessionsDir, "2026-02-02T00-00-00-000Z_i18nerror.jsonl");
      const entry = (id: string, parentId: string | null, message: unknown) =>
        JSON.stringify({ type: "message", id, parentId, timestamp: "2026-02-02T00:00:00.000Z", message });
      writeFileSync(
        sessionFile,
        `${[
          JSON.stringify({
            type: "session",
            version: 3,
            id: "i18nerror",
            timestamp: "2026-02-02T00:00:00.000Z",
            cwd,
          }),
          entry("a1", null, { role: "user", content: [{ type: "text", text: "Read this file" }], timestamp: 1 }),
          entry("a2", "a1", {
            role: "assistant",
            content: [],
            api: "anthropic-messages",
            provider: "test",
            model: "t",
            usage: {
              input: 1,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage: raw,
            timestamp: 2,
          }),
        ].join("\n")}\n`,
        "utf-8",
      );
      writeFileSync(join(home, "settings.json"), JSON.stringify({ locale: "en" }));
      writeFileSync(
        join(home, "sessions.json"),
        JSON.stringify([
          {
            id: "e2e-i18n-error",
            mode: "project",
            cwd,
            title: "E2E error card",
            model: null,
            thinkingLevel: "medium",
            sessionFile,
            createdAt: 1,
            updatedAt: 1,
          },
        ]),
        "utf-8",
      );
    },
  });
  try {
    const page = await app.firstWindow();
    await page.locator("div.group", { hasText: "E2E error card" }).first().click();
    const card = page.getByTestId("run-error-card");
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card).toContainText(raw);
    await expect(card).not.toContainText(/[\u4e00-\u9fff]/);
  } finally {
    await app.close();
  }
});

for (const locale of ["zh-CN", "en"] as const) {
  test(`first launch uses persisted ${locale} before painting the app`, async () => {
    const app = await launchApp({
      seed: (home) => writeFileSync(join(home, "settings.json"), JSON.stringify({ locale })),
    });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId("brand")).toBeVisible({ timeout: 15000 });
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await page.keyboard.press("Meta+Comma");
      await expect(page.getByTestId("settings-nav-general")).toHaveText(locale === "en" ? "General" : "通用");
      await page.keyboard.press("Escape");
      await page.getByTestId("sidebar-new-chat").click();
      await expect(page.getByTestId("empty-state")).toBeVisible();
      if (locale === "en") await expect(page.locator("body")).not.toContainText(/[\u4e00-\u9fff]/);
    } finally {
      await app.close();
    }
  });
}
