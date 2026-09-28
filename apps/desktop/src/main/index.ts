/**
 * Spcode 主进程入口：窗口、IPC、会话注册表、自动更新（未配置更新源时静默跳过）。
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IPC, type AppSettings, type HostCommand, type HostEvent, type SessionMode } from "@spcode/shared";
import { AgentBridge } from "./agent-bridge.js";
import { QuotaService } from "./quota-service.js";
import { SessionRegistry } from "./session-registry.js";
import { SettingsStore } from "./settings-store.js";
import { UsageLedger } from "./usage-ledger.js";
import { setupAutoUpdater } from "./updater.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const settings = new SettingsStore();
const registry = new SessionRegistry();
const ledger = new UsageLedger();
const quota = new QuotaService();
const bridge = new AgentBridge({ getPermissionMode: () => settings.get().permissionMode });

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "Spcode",
    backgroundColor: "#0b0f14",
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
// 会话生命周期：宿主事件里提取 sessionFile 回填注册表
// ---------------------------------------------------------------------------

function watchSessionLifecycle(): void {
  bridge.onEvent((event: HostEvent) => {
    // 用量落账
    if (event.type === "session.usage") {
      ledger.append(event.usage);
      return;
    }
    if (event.type !== "response" || !event.success) return;
    const data = event.data as
      | { sessionId?: string; sessionFile?: string | null; model?: { provider: string; modelId: string } | null; thinkingLevel?: string }
      | undefined;
    if (!data?.sessionId) return;
    const entry = registry.get(data.sessionId);
    if (!entry) return;
    registry.patch(data.sessionId, {
      sessionFile: data.sessionFile ?? entry.sessionFile,
      model: data.model ?? entry.model,
      thinkingLevel: data.thinkingLevel ?? entry.thinkingLevel,
    });
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle(IPC.hostCommand, async (_e, cmd: HostCommand) => {
    if (!("id" in cmd)) throw new Error("hostCommand requires id");

    // 创建/恢复会话时写入注册表
    if (cmd.type === "session.create") {
      const now = Date.now();
      registry.upsert({
        id: cmd.payload.sessionId,
        mode: cmd.payload.mode,
        cwd: cmd.payload.cwd,
        title: cmd.payload.mode === "chat" ? "新聊天" : (cmd.payload.cwd.split("/").pop() ?? "新项目"),
        model: cmd.payload.model ?? settings.get().defaultModel,
        thinkingLevel: cmd.payload.thinkingLevel ?? settings.get().defaultThinkingLevel,
        sessionFile: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    return bridge.call(cmd);
  });

  ipcMain.on(IPC.permissionReply, (_e, payload: { requestId: string; approved: boolean }) => {
    bridge.replyPermission(payload.requestId, payload.approved);
  });

  ipcMain.on(IPC.questionReply, (_e, payload: { requestId: string; answers: Record<string, string> }) => {
    bridge.replyQuestion(payload.requestId, payload.answers);
  });

  ipcMain.handle(IPC.listSessions, () => registry.list());
  ipcMain.handle(IPC.removeSession, (_e, id: string) => {
    registry.remove(id);
    // 宿主里的活跃实例也一并释放
    void bridge
      .call({ id: `dispose-${id}`, type: "session.dispose", payload: { sessionId: id } })
      .catch(() => {});
  });

  ipcMain.handle(IPC.usageSummary, (_e, days?: number) => ledger.summarize(days ?? 14));
  ipcMain.handle(IPC.quotaQuery, () => quota.queryAll());

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
  watchSessionLifecycle();
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

export type { SessionMode };
