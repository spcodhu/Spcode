/**
 * Spcode 主进程入口：窗口、IPC、自动更新（未配置更新源时静默跳过）。
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IPC, type AppSettings, type HostCommand } from "@spcode/shared";
import { AgentBridge } from "./agent-bridge.js";
import { SettingsStore } from "./settings-store.js";
import { setupAutoUpdater } from "./updater.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const settings = new SettingsStore();
const bridge = new AgentBridge({ getPermissionMode: () => settings.get().permissionMode });

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "Spcode",
    backgroundColor: "#0d1117",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const unbind = bridge.bindWindow(mainWindow.webContents);
  mainWindow.on("closed", () => {
    unbind();
    mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle(IPC.hostCommand, async (_e, cmd: HostCommand) => {
    if (!("id" in cmd)) throw new Error("hostCommand requires id");
    return bridge.call(cmd);
  });

  ipcMain.on(IPC.permissionReply, (_e, payload: { requestId: string; approved: boolean }) => {
    bridge.replyPermission(payload.requestId, payload.approved);
  });

  ipcMain.handle(IPC.pickDirectory, async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
      title: "选择项目文件夹",
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.getSettings, () => settings.get());
  ipcMain.handle(IPC.setSettings, (_e, patch: Partial<AppSettings>) => settings.set(patch));
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

void app.whenReady().then(async () => {
  registerIpc();
  await bridge.start();
  createWindow();
  setupAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void bridge.dispose();
});
