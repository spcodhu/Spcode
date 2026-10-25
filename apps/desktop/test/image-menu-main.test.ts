import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showImageContextMenu } from "../src/main/image-actions.js";

const state = vi.hoisted(() => ({
  template: [] as MenuItemConstructorOptions[],
  write: vi.fn(),
  save: vi.fn(),
  open: vi.fn(),
  temp: "",
}));

vi.mock("electron", () => {
  const owner = { isDestroyed: () => false };
  return {
    app: { getPath: () => state.temp, once: vi.fn() },
    BrowserWindow: { fromWebContents: () => owner },
    clipboard: { write: state.write },
    ClipboardItem: class {
      constructor(public items: Record<string, Blob>) {}
    },
    dialog: { showSaveDialog: state.save },
    Menu: {
      buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
        state.template = template;
        return { once: vi.fn(), popup: vi.fn() };
      },
    },
    shell: { openPath: state.open },
  };
});

const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const image = { name: "pixel.png", mimeType: "image/png", data: bytes.toString("base64") };
const event = { sender: {} } as IpcMainInvokeEvent;

beforeEach(() => {
  state.temp = mkdtempSync(join(tmpdir(), "spcode-image-menu-"));
  state.template = [];
  state.write.mockReset().mockResolvedValue(undefined);
  state.save.mockReset();
  state.open.mockReset().mockResolvedValue("");
});
afterEach(() => {
  rmSync(state.temp, { recursive: true, force: true });
});

function click(index: number): void {
  const item = state.template[index];
  expect(item).toBeTruthy();
  (item!.click as () => void)();
}

describe("桌面原生图片菜单动作", () => {
  it("复制图片写入真实 MIME 与字节，不是 base64 文本", async () => {
    const pending = showImageContextMenu(event, image);
    expect(state.template.map((item) => item.label)).toEqual(["复制图片", "图片另存为…", "用默认应用打开"]);
    click(0);
    await expect(pending).resolves.toEqual({ type: "copied" });
    expect(state.write).toHaveBeenCalledTimes(1);
    const item = state.write.mock.calls[0]![0][0] as { items: Record<string, Blob> };
    const blob = item.items["image/png"]!;
    expect(blob.type).toBe("image/png");
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(bytes);
  });

  it("另存为保留原始字节；用户取消不写文件", async () => {
    const target = join(state.temp, "saved.png");
    state.save.mockResolvedValue({ canceled: false, filePath: target });
    let pending = showImageContextMenu(event, image);
    click(1);
    await expect(pending).resolves.toEqual({ type: "saved", path: target });
    expect(readFileSync(target)).toEqual(bytes);

    state.save.mockResolvedValue({ canceled: true });
    pending = showImageContextMenu(event, image);
    click(1);
    await expect(pending).resolves.toEqual({ type: "cancelled" });
  });

  it("默认应用打开使用随机临时文件并保留图片内容", async () => {
    const pending = showImageContextMenu(event, image);
    click(2);
    const result = await pending;
    expect(result.type).toBe("opened");
    if (result.type !== "opened") return;
    expect(result.path).toContain(join(state.temp, "spcode-image-preview"));
    expect(readFileSync(result.path)).toEqual(bytes);
    expect(state.open).toHaveBeenCalledWith(result.path);
  });
});
