import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

const SESSION_ID = "e2e-message-images";
const TITLE = "多图消息";
const CWD = mkdtempSync(join(tmpdir(), "spcode-e2e-images-"));
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function seed(home: string): void {
  const sessionsDir = join(home, "agent", "sessions", "-tmp-spcode-e2e-images");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "e2emessageimages",
      timestamp: "2026-02-01T00:00:00.000Z",
      cwd: CWD,
    }),
    JSON.stringify({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-02-01T00:00:00.000Z",
      message: {
        role: "user",
        timestamp: 1769904000000,
        content: [
          ...[1, 2, 3, 4].map((index) => ({
            type: "image",
            data: PIXEL,
            mimeType: "image/png",
            name: `图${index}.png`,
          })),
          { type: "text", text: "这四张图并排展示" },
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

test("多图单行溢出横滚，预览支持缩放与切图复位", async () => {
  const app = await launchApp({ seed });
  const window = await app.firstWindow();
  await window.locator("div.group", { hasText: TITLE }).first().click();

  const strip = window.getByTestId("message-image-strip");
  await expect(strip).toBeVisible({ timeout: 15000 });
  await expect(window.getByTestId("message-image")).toHaveCount(4);
  expect(await strip.evaluate((element) => getComputedStyle(element).flexWrap)).toBe("nowrap");
  expect(await strip.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
  const sizes = await strip.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
    images: [...element.querySelectorAll("img")].map((image) => image.getBoundingClientRect().width),
  }));
  expect(sizes.scroll > sizes.client, JSON.stringify(sizes)).toBe(true);

  await window.getByTestId("message-image").first().click();
  await expect(window.getByTestId("image-lightbox")).toBeVisible();
  await window.getByTestId("image-preview-zoom-in").click();
  await expect(window.getByTestId("image-preview-zoom-reset")).toHaveText("125%");
  await window.getByTestId("image-preview-next").click();
  await expect(window.getByTestId("image-preview-zoom-reset")).toHaveText("100%");
  await window.getByTestId("image-preview-close").click();
  await expect(window.getByTestId("image-lightbox")).toHaveCount(0);
  await app.close();
});
