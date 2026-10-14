/**
 * 自动更新：electron-updater 轮询 GitHub Releases（Finch 式手动下载）。
 *
 * 原则：绝不自动下载。发现新版本只把状态推给渲染进程（侧栏出现「更新」按钮），
 * 下载、重启安装、忽略版本全部由用户在 UI 上主动触发：
 *   updateDownload() → 开始下载（进度经 download-progress 推送）
 *   installUpdate()  → quitAndInstall(false, true)
 *   ignoreVersion()  → 该版本不再提示（由调用方持久化到 settings）
 *
 * 历史 bug：autoDownload=true 时下载完成弹系统对话框，「立即重启更新」点了没反应——
 * 原因是 quitAndInstall() 缺省 isForceRunAfter=false，macOS 上安装后不会重启，
 * 表现为"点了没反应"（进程实际退出了）。这里显式传 true。
 *
 * UPDATE_OWNER/UPDATE_REPO 为占位值时直接跳过检查。
 */
import { app } from "electron";
import pkg from "electron-updater";
import { normalizeReleaseNotes, resolveAllowPrerelease, type UpdateState } from "@spcode/shared";

const { autoUpdater } = pkg;

const UPDATE_OWNER = "spcodhu";
const UPDATE_REPO = "Spcode";

let currentState: UpdateState = { status: "idle" };
let onStateChange: ((s: UpdateState) => void) | null = null;
/** 正在/即将下载的版本（download-progress 事件不携带版本号，需自行跟踪） */
let pendingVersion = "";

function setState(s: UpdateState): void {
  currentState = s;
  onStateChange?.(s);
}

/** 渲染进程启动时拉取当前状态（错过推送也不丢） */
export function getUpdateState(): UpdateState {
  return currentState;
}

/** 用户点了「确认更新」：开始下载（出错经 error 事件进 error 态） */
export function downloadUpdate(): void {
  void autoUpdater.downloadUpdate().catch(() => {
    /* error 事件会带上具体原因，这里只兜底 promise 拒绝 */
  });
}

/**
 * 用户点了「立即重启」：安装并强制重启。
 * forceRunAfter=true 是关键——否则 macOS 上静默退出不重启（上一版"没反应"的根因）。
 */
export function installUpdate(): void {
  try {
    autoUpdater.quitAndInstall(false, true);
  } catch (e) {
    setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

/** 用户点了「忽略此版本」：回到 idle（持久化由调用方负责） */
export function ignoreVersion(): void {
  setState({ status: "idle" });
}

export function setupAutoUpdater(opts: {
  isEnabled: () => boolean;
  getBetaUpdates: () => boolean | undefined;
  /** 设置里被忽略的版本号（与该版本一致时不再提示） */
  getIgnoredVersion: () => string | undefined;
  /** 状态变化回调（主进程负责转发渲染进程） */
  onState: (s: UpdateState) => void;
}): void {
  if (!app.isPackaged) return;
  if (UPDATE_OWNER.startsWith("TODO")) {
    console.info("[updater] update source not configured, skipping");
    return;
  }
  onStateChange = opts.onState;

  autoUpdater.setFeedURL({ provider: "github", owner: UPDATE_OWNER, repo: UPDATE_REPO });
  // 关键：不自动下载、不在退出时自动安装——一切由用户触发
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("update-available", (info) => {
    if (info.version === opts.getIgnoredVersion()) {
      setState({ status: "idle" });
      return;
    }
    pendingVersion = info.version;
    setState({ status: "available", version: info.version, releaseNotes: normalizeReleaseNotes(info.releaseNotes) });
  });
  autoUpdater.on("update-not-available", () => setState({ status: "idle" }));
  autoUpdater.on("download-progress", (p) => {
    setState({ status: "downloading", version: pendingVersion, percent: Math.max(0, Math.min(100, p.percent)) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    pendingVersion = info.version;
    setState({ status: "downloaded", version: info.version });
  });
  autoUpdater.on("error", (e) => {
    console.warn("[updater] error", e);
    setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
  });

  /** 每次检查前重读通道设置：用户在设置页切换后无需重启即生效 */
  const check = () => {
    if (!opts.isEnabled()) return;
    autoUpdater.allowPrerelease = resolveAllowPrerelease(opts.getBetaUpdates(), app.getVersion());
    void autoUpdater.checkForUpdates().catch((e) => {
      console.warn("[updater] check failed", e);
    });
  };
  check();
  // 每 4 小时复查；unref 防止这个定时器本身拖住进程退出
  const timer = setInterval(check, 4 * 60 * 60 * 1000);
  timer.unref?.();
}
