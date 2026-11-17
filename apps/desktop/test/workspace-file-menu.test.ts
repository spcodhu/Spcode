import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { showWorkspaceFileMenu } from "../src/main/workspace-file-menu.js";

const state = vi.hoisted(() => ({
  template: [] as MenuItemConstructorOptions[],
  onClose: null as (() => void) | null,
  writeText: vi.fn(),
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
  destroyed: false,
}));

vi.mock("electron", () => {
  const owner = { isDestroyed: () => state.destroyed };
  return {
    BrowserWindow: { fromWebContents: () => owner },
    clipboard: { writeText: state.writeText },
    Menu: {
      buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
        state.template = template;
        return {
          once: (_name: string, cb: () => void) => {
            state.onClose = cb;
          },
          popup: vi.fn(),
        };
      },
    },
    shell: { openPath: state.openPath, showItemInFolder: state.showItemInFolder },
  };
});

const event = { sender: {} } as IpcMainInvokeEvent;
const target = "/tmp/project/README.md";

beforeEach(() => {
  state.template = [];
  state.onClose = null;
  state.destroyed = false;
  state.writeText.mockReset();
  state.openPath.mockReset().mockResolvedValue("");
  state.showItemInFolder.mockReset();
});

function click(index: number): void {
  const item = state.template[index];
  expect(item).toBeTruthy();
  (item!.click as () => void)();
}

describe("第三屏文件右键菜单动作", () => {
  it("菜单按「默认应用打开 / 复制路径 / 在文件管理器里显示」排列", () => {
    void showWorkspaceFileMenu(event, target);
    const labels = state.template.map((item) => item.label ?? item.type);
    // 平台差异只在最后一项的文案里：macOS 是 Finder，Windows/Linux 是文件资源管理器。
    // 这里用模式匹配而不是硬编码全文，避免改文案就把 Windows CI 弄挂（beta.40 就是这么挂的）。
    const reveal = labels[3] ?? "";
    if (process.platform === "darwin") expect(reveal).toContain("Finder");
    else expect(reveal).toContain("资源管理器");
    expect(labels.slice(0, 3)).toEqual(["用默认应用打开", "复制文件路径", "separator"]);
  });

  it("复制路径写剪贴板，不读文件内容", async () => {
    const pending = showWorkspaceFileMenu(event, target);
    click(1);
    await expect(pending).resolves.toEqual({ type: "copied", path: target });
    expect(state.writeText).toHaveBeenCalledWith(target);
    expect(state.openPath).not.toHaveBeenCalled();
  });

  it("默认应用打开用守卫解析后的绝对路径；打开失败以 reject 上报", async () => {
    let pending = showWorkspaceFileMenu(event, target);
    click(0);
    await expect(pending).resolves.toEqual({ type: "opened", path: target });
    expect(state.openPath).toHaveBeenCalledWith(target);

    state.openPath.mockResolvedValue("No application knows how to open this file");
    pending = showWorkspaceFileMenu(event, target);
    click(0);
    await expect(pending).rejects.toThrow("No application knows how to open this file");
  });

  it("在文件管理器中显示调用系统接口", async () => {
    const pending = showWorkspaceFileMenu(event, target);
    click(3);
    await expect(pending).resolves.toEqual({ type: "revealed", path: target });
    expect(state.showItemInFolder).toHaveBeenCalledWith(target);
  });

  it("用户关掉菜单且未选中任何项时返回 cancelled", async () => {
    const pending = showWorkspaceFileMenu(event, target);
    state.onClose?.();
    await expect(pending).resolves.toEqual({ type: "cancelled" });
  });

  it("已选中动作后关菜单不会覆盖结果", async () => {
    const pending = showWorkspaceFileMenu(event, target);
    click(1);
    state.onClose?.();
    await expect(pending).resolves.toEqual({ type: "copied", path: target });
  });

  it("窗口已销毁时立刻 rejects，不尝试弹菜单", async () => {
    state.destroyed = true;
    await expect(showWorkspaceFileMenu(event, target)).rejects.toThrow("该窗口已关闭，无法弹出文件菜单");
  });
});
