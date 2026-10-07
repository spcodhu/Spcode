/**
 * 自动更新：electron-updater 轮询 GitHub Releases。
 *
 * 更新源为 spcodhu/Spcode 的 GitHub Releases（配合 .github/workflows/release.yml，
 * 推送 v* tag 即发布新版本）。UPDATE_OWNER/UPDATE_REPO 为占位值时直接跳过检查。
 *
 * isEnabled 读取设置页的「启动时检查更新」开关（每次检查时实时读，关掉即刻生效）。
 * 下载完成后不自动重启：弹系统对话框让用户选「立即重启更新 / 稍后」，
 * 避免长任务/定时任务运行中被零感知重启截断。
 */
import { app, type BrowserWindow, dialog } from "electron";
import pkg from "electron-updater";

const { autoUpdater } = pkg;

const UPDATE_OWNER = "spcodhu";
const UPDATE_REPO = "Spcode";

export function setupAutoUpdater(
  isEnabled: () => boolean = () => true,
  getWindow: () => BrowserWindow | null = () => null,
): void {
  if (!app.isPackaged) return;
  if (UPDATE_OWNER.startsWith("TODO")) {
    console.info("[updater] update source not configured, skipping");
    return;
  }
  autoUpdater.setFeedURL({ provider: "github", owner: UPDATE_OWNER, repo: UPDATE_REPO });
  autoUpdater.autoDownload = true;
  autoUpdater.on("update-downloaded", (info) => {
    const win = getWindow();
    const opts = {
      type: "info" as const,
      title: "更新已就绪",
      message: `新版本${info.version ? ` ${info.version}` : ""}已下载完成`,
      detail: "重启应用以完成更新。进行中的会话会被中断。",
      buttons: ["立即重启更新", "稍后"],
      defaultId: 0,
      cancelId: 1,
    };
    void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });
  const check = () => {
    if (!isEnabled()) return;
    void autoUpdater.checkForUpdates().catch((e) => {
      console.warn("[updater] check failed", e);
    });
  };
  check();
  // 每 4 小时复查；unref 防止这个定时器本身拖住进程退出
  const timer = setInterval(check, 4 * 60 * 60 * 1000);
  timer.unref?.();
}
