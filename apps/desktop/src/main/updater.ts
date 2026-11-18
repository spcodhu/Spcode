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

import { normalizeReleaseNotes, resolveAllowPrerelease, type UpdateState } from "@spcode/shared";
import { app } from "electron";
import pkg from "electron-updater";

const { autoUpdater } = pkg;

const UPDATE_OWNER = "spcodhu";
const UPDATE_REPO = "Spcode";

let currentState: UpdateState = { status: "idle" };
let onStateChange: ((s: UpdateState) => void) | null = null;
/** 后台检查期间的网络错误只记录日志，不能伪装成用户下载失败。 */
let checkingForUpdates = false;
/** 当前在途检查是否来自关于页手动点击：结果要给用户明确反馈（up-to-date / 检查失败） */
let manualCheck = false;
/** setupAutoUpdater 是否真的初始化了（开发运行/未配置更新源时早退，手动检查不可用） */
let initialized = false;
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
    setState({ status: "error", message: e instanceof Error ? e.message : String(e), source: "download" });
  }
}

/** 用户点了「忽略此版本」：回到 idle（持久化由调用方负责） */
export function ignoreVersion(): void {
  setState({ status: "idle" });
}

/**
 * 关于页「检查更新」：不受 autoUpdate 开关限制（用户显式动作）。
 * 返回 false = 更新器未初始化（开发运行或未配置更新源），UI 据此提示不可用。
 * 已在检查/下载/待重启时不重复发起，避免覆盖进行中状态。
 */
export function checkForUpdatesNow(): boolean {
  if (!initialized) return false;
  if (
    currentState.status === "checking" ||
    currentState.status === "downloading" ||
    currentState.status === "downloaded"
  ) {
    return true;
  }
  checkForUpdates(true);
  return true;
}

/** 发起一次检查（manual=true 时绕过 autoUpdate 开关并给用户反馈） */
let checkForUpdates: (manual?: boolean) => void = () => {};

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
  initialized = true;

  autoUpdater.setFeedURL({ provider: "github", owner: UPDATE_OWNER, repo: UPDATE_REPO });
  // 关键：不自动下载、不在退出时自动安装——一切由用户触发
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("update-available", (info) => {
    // 下载中/待重启时任何版本的 update-available 都不转态：
    // 避免把仍在下载的旧版本错标成新版本，或丢失已下载版本的重启入口；
    // 重启完成后下一轮检查自然会发现更新的版本。
    if (currentState.status === "downloading" || currentState.status === "downloaded") return;
    if (info.version === opts.getIgnoredVersion()) {
      // 手动检查时给明确反馈；被忽略的版本不再提示，对用户等价于「没有可更新的版本」
      setState(manualCheck ? { status: "up-to-date", version: app.getVersion() } : { status: "idle" });
      return;
    }
    pendingVersion = info.version;
    setState({ status: "available", version: info.version, releaseNotes: normalizeReleaseNotes(info.releaseNotes) });
  });
  autoUpdater.on("update-not-available", () => {
    if (currentState.status === "downloading" || currentState.status === "downloaded") return;
    setState(manualCheck ? { status: "up-to-date", version: app.getVersion() } : { status: "idle" });
  });
  autoUpdater.on("download-progress", (p) => {
    setState({ status: "downloading", version: pendingVersion, percent: Math.max(0, Math.min(100, p.percent)) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    pendingVersion = info.version;
    setState({ status: "downloaded", version: info.version });
  });
  autoUpdater.on("error", (e) => {
    // electron-updater 的检查与下载共用 error 事件。检查失败时当前并没有可下载的更新：
    // 后台检查只记日志；手动检查要把原因透出到关于页（source=check，区别于下载错误）。
    if (checkingForUpdates) {
      if (manualCheck) {
        setState({ status: "error", message: e instanceof Error ? e.message : String(e), source: "check" });
      } else {
        console.warn("[updater] check failed", e);
      }
      return;
    }
    console.warn("[updater] error", e);
    setState({ status: "error", message: e instanceof Error ? e.message : String(e), source: "download" });
  });

  /** 每次检查前重读通道设置：用户在设置页切换后无需重启即生效 */
  checkForUpdates = (manual = false) => {
    if (!manual && !opts.isEnabled()) return;
    autoUpdater.allowPrerelease = resolveAllowPrerelease(opts.getBetaUpdates(), app.getVersion());
    checkingForUpdates = true;
    if (manual) {
      manualCheck = true;
      setState({ status: "checking" });
    }
    void autoUpdater
      .checkForUpdates()
      .catch((e) => {
        console.warn("[updater] check failed", e);
      })
      .finally(() => {
        // electron-updater 会先同步发出 error，再拒绝 checkForUpdates Promise。
        checkingForUpdates = false;
        // 兑底：手动检查复用了事件已发出的在途后台检查等早退路径时，
        // 可能没有任何状态事件落地——回 idle 释放按钮，不伪造检查结果。
        if (manualCheck && currentState.status === "checking") setState({ status: "idle" });
        manualCheck = false;
      });
  };
  checkForUpdates();
  // 每 4 小时复查；unref 防止这个定时器本身拖住进程退出
  const timer = setInterval(() => checkForUpdates(), 4 * 60 * 60 * 1000);
  timer.unref?.();
}
