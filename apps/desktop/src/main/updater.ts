/**
 * 自动更新：electron-updater 轮询 GitHub Releases。
 *
 * 当前未创建远程仓库（v1 纯本地构建决策）：
 * UPDATE_OWNER/UPDATE_REPO 为占位值时直接跳过，建好仓库后改这两个常量
 * 并推送 tag 即可启用（配合 .github/workflows/release.yml）。
 *
 * isEnabled 读取设置页的「启动时检查更新」开关（每次检查时实时读，关掉即刻生效）。
 */
import { app } from "electron";
import pkg from "electron-updater";

const { autoUpdater } = pkg;

const UPDATE_OWNER = "TODO-OWNER";
const UPDATE_REPO = "TODO-REPO";

export function setupAutoUpdater(isEnabled: () => boolean = () => true): void {
  if (!app.isPackaged) return;
  if (UPDATE_OWNER.startsWith("TODO")) {
    console.info("[updater] update source not configured, skipping");
    return;
  }
  autoUpdater.setFeedURL({ provider: "github", owner: UPDATE_OWNER, repo: UPDATE_REPO });
  autoUpdater.autoDownload = true;
  autoUpdater.on("update-downloaded", () => {
    autoUpdater.quitAndInstall();
  });
  const check = () => {
    if (!isEnabled()) return;
    void autoUpdater.checkForUpdates().catch((e) => {
      console.warn("[updater] check failed", e);
    });
  };
  check();
  // 每 4 小时复查
  setInterval(check, 4 * 60 * 60 * 1000);
}
