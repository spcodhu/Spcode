/**
 * 第三屏文件右键菜单：默认应用打开 / 复制文件路径 / 在文件管理器中显示。
 *
 * 路径由调用方（主进程 IPC 处理）先过工作区或 plans 目录守卫，这里只负责弹原生菜单
 * 并执行用户选择的动作；失败以 reject 上报，渲染层统一走 lastError 提示。
 */
import type { WorkspaceFileMenuResult } from "@spcode/shared";
import { i18n } from "@spcode/shared/i18n";
import {
  BrowserWindow,
  clipboard,
  type IpcMainInvokeEvent,
  Menu,
  type MenuItemConstructorOptions,
  shell,
} from "electron";

/** macOS 叫 Finder，其它平台是文件资源管理器。 */
function revealLabel(): string {
  return i18n.t(process.platform === "darwin" ? "chat:workspace.revealInFinder" : "chat:workspace.revealInExplorer");
}

/** 在事件来源窗口弹出文件菜单；Promise 在用户操作完成或菜单取消后结束。 */
export function showWorkspaceFileMenu(event: IpcMainInvokeEvent, path: string): Promise<WorkspaceFileMenuResult> {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner.isDestroyed()) return Promise.reject(new Error(i18n.t("chat:workspace.fileMenuUnavailable")));

  return new Promise((resolve, reject) => {
    let chosen = false;
    let settled = false;
    const done = (result: WorkspaceFileMenuResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const run = (action: () => WorkspaceFileMenuResult | Promise<WorkspaceFileMenuResult>) => {
      chosen = true;
      void Promise.resolve().then(action).then(done).catch(fail);
    };

    const template: MenuItemConstructorOptions[] = [
      {
        label: i18n.t("chat:workspace.openDefault"),
        click: () =>
          run(async () => {
            const error = await shell.openPath(path);
            if (error) throw new Error(i18n.t("chat:workspace.fileMenuFailed", { error }));
            return { type: "opened", path };
          }),
      },
      {
        label: i18n.t("chat:workspace.copyPath"),
        click: () =>
          run(() => {
            clipboard.writeText(path);
            return { type: "copied", path };
          }),
      },
      { type: "separator" },
      {
        label: revealLabel(),
        click: () =>
          run(() => {
            shell.showItemInFolder(path);
            return { type: "revealed", path };
          }),
      },
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
