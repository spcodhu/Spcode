import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageAttachment, ImageContextMenuResult } from "@spcode/shared";
import { i18n } from "@spcode/shared/i18n";
import {
  app,
  BrowserWindow,
  ClipboardItem,
  clipboard,
  dialog,
  type IpcMainInvokeEvent,
  Menu,
  type MenuItemConstructorOptions,
  shell,
} from "electron";
import { type DecodedImage, decodeImageAttachment } from "./image-file.js";

const previewFiles = new Set<string>();
let cleanupRegistered = false;

function trackPreviewFile(path: string): void {
  previewFiles.add(path);
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    app.once("will-quit", () => {
      for (const file of previewFiles) {
        try {
          rmSync(file, { force: true });
        } catch {
          // 临时文件清理失败不影响退出。
        }
      }
      previewFiles.clear();
    });
  }
  const timer = setTimeout(() => {
    previewFiles.delete(path);
    void rm(path, { force: true }).catch(() => {});
  }, 30 * 60_000);
  timer.unref();
}

async function openWithDefaultApp(image: DecodedImage): Promise<ImageContextMenuResult> {
  const dir = join(app.getPath("temp"), "spcode-image-preview");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}-${image.name}`);
  await writeFile(path, image.bytes, { flag: "wx" });
  const error = await shell.openPath(path);
  if (error) {
    await rm(path, { force: true }).catch(() => {});
    throw new Error(error);
  }
  trackPreviewFile(path);
  return { type: "opened", path };
}

async function saveImage(owner: BrowserWindow, image: DecodedImage): Promise<ImageContextMenuResult> {
  const result = await dialog.showSaveDialog(owner, {
    title: i18n.t("chat:image.saveAs"),
    defaultPath: image.name,
    filters: [{ name: i18n.t("integration:files.images"), extensions: [image.name.split(".").pop() ?? "png"] }],
  });
  if (result.canceled || !result.filePath) return { type: "cancelled" };
  await writeFile(result.filePath, image.bytes);
  return { type: "saved", path: result.filePath };
}

/** 在事件来源窗口弹原生图片菜单；Promise 在用户操作完成或菜单取消后结束。 */
export function showImageContextMenu(event: IpcMainInvokeEvent, raw: ImageAttachment): Promise<ImageContextMenuResult> {
  let image: DecodedImage;
  try {
    image = decodeImageAttachment(raw);
  } catch {
    throw new Error(i18n.t("chat:image.invalid"));
  }
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner.isDestroyed()) throw new Error(i18n.t("chat:image.unavailable"));

  return new Promise((resolve, reject) => {
    let chosen = false;
    let settled = false;
    const done = (result: ImageContextMenuResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const run = (action: () => ImageContextMenuResult | Promise<ImageContextMenuResult>) => {
      chosen = true;
      void Promise.resolve().then(action).then(done).catch(fail);
    };
    const template: MenuItemConstructorOptions[] = [
      {
        label: i18n.t("chat:image.copy"),
        click: () =>
          run(async () => {
            const bytes = image.bytes.buffer.slice(
              image.bytes.byteOffset,
              image.bytes.byteOffset + image.bytes.byteLength,
            ) as ArrayBuffer;
            const item = new ClipboardItem({ [image.mimeType]: new Blob([bytes], { type: image.mimeType }) });
            await clipboard.write([item]);
            return { type: "copied" };
          }),
      },
      { label: i18n.t("chat:image.saveAs"), click: () => run(() => saveImage(owner, image)) },
      { label: i18n.t("chat:image.openDefault"), click: () => run(() => openWithDefaultApp(image)) },
    ];
    const menu = Menu.buildFromTemplate(template);
    menu.once("menu-will-close", () => {
      if (!chosen) done({ type: "cancelled" });
    });
    try {
      menu.popup({ window: owner });
    } catch (error) {
      fail(error);
    }
  });
}
