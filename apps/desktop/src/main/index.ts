/**
 * Spcode 主进程入口：窗口、IPC、会话注册表、定时任务调度、自动更新（未配置更新源时静默跳过）。
 */

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AdvancedSearchConfig,
  type AppSettings,
  baseName,
  cleanSessionTitle,
  type HostCommand,
  type HostEvent,
  IPC,
  type ScheduleTask,
  type ScheduleTaskInput,
  type SessionMode,
} from "@spcode/shared";
import { executeSearch, isAdvancedSearchReady } from "@spcode/shared/advanced-search";
import { resolveSpcodeHome } from "@spcode/shared/node";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { AgentBridge } from "./agent-bridge.js";
import { QuotaService } from "./quota-service.js";
import { RemoteServer } from "./remote/index.js";
import { Scheduler } from "./scheduler.js";
import {
  backfillSessionFile,
  isDefaultTitle,
  removeSession as removeSessionEverywhere,
} from "./session-helpers.js";
import { SessionRegistry } from "./session-registry.js";
import { searchSessions } from "./session-search.js";
import { SettingsStore } from "./settings-store.js";
import { setupAutoUpdater } from "./updater.js";
import { UsageLedger } from "./usage-ledger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const settings = new SettingsStore();
const registry = new SessionRegistry();
const ledger = new UsageLedger();
const quota = new QuotaService(undefined, (providerId) => ledger.providerUsage(providerId));
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

  // 安全：外链一律转外部浏览器打开，不允许新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // 安全：拦截渲染进程内导航（模型输出的 Markdown 链接同窗点击会导航走本窗口，
  // 远程页面将继承 preload 能力）。file://（打包后的本地页面）与 dev server 放行。
  mainWindow.webContents.on("will-navigate", (e, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (url.startsWith("file://") || (devUrl && url.startsWith(devUrl))) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
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
    // AI 通过 RenameSession 起的标题：持久化到注册表（渲染进程由广播自行更新）
    if (event.type === "session.renamed") {
      registry.patch(event.sessionId, { title: event.title, updatedAt: Date.now() });
      return;
    }
    // 计划模式开关：持久化到注册表（恢复会话时据此还原计划态）
    if (event.type === "session.planmode") {
      registry.patch(event.sessionId, { planMode: event.enabled });
      return;
    }
    // WritePlan 落盘：回填计划文件路径
    if (event.type === "session.plan") {
      registry.patch(event.sessionId, { planFile: event.path });
      return;
    }
  });
}

/** 判断标题是否仍是出厂默认的逻辑已抽到 session-helpers.ts（远程控制链路复用） */

// ---------------------------------------------------------------------------
// 定时任务：触发 = 新建会话（标题固定为任务名）+ 注入 prompt
// ---------------------------------------------------------------------------

const scheduler = new Scheduler({
  fire: fireScheduledTask,
  notify: (task, sessionId) => {
    bridge.emitLocal({ type: "schedule.fired", taskId: task.id, name: task.name, sessionId });
    bridge.emitLocal({ type: "sessions.changed" });
  },
});

async function fireScheduledTask(task: ScheduleTask): Promise<string> {
  const sessionId = randomUUID();
  const mode: SessionMode = task.target.kind === "project" ? "project" : "chat";
  const cwd = task.target.kind === "project" ? task.target.cwd : "";
  const now = Date.now();
  registry.upsert({
    id: sessionId,
    mode,
    cwd,
    title: task.name,
    model: settings.get().defaultModel,
    thinkingLevel: settings.get().defaultThinkingLevel,
    sessionFile: null,
    createdAt: now,
    updatedAt: now,
  });
  // 走与用户手动创建相同的 session.create 链路，但关闭标题自动化（标题 = 任务名）
  const createCmd = AgentBridge.withId({
    type: "session.create",
    payload: {
      sessionId,
      mode,
      cwd,
      model: settings.get().defaultModel ?? undefined,
      thinkingLevel: settings.get().defaultThinkingLevel,
      noTitleAutomation: true,
    },
  });
  const info = await bridge.call(createCmd);
  backfillSessionFile(createCmd, info, registry);
  await bridge.call(AgentBridge.withId({ type: "session.prompt", payload: { sessionId, text: task.prompt } }));
  return sessionId;
}

// ---------------------------------------------------------------------------
// 远程控制（手机 PWA）：复用 settings/bridge/scheduler/registry 单例
// ---------------------------------------------------------------------------

const remote = new RemoteServer({ settings, bridge, scheduler, registry });

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
  // 长调用命令的超时覆盖（bridge.call 默认 30s——评审 P1-8）
  const CALL_TIMEOUTS: Partial<Record<HostCommand["type"], number>> = {
    "theme.generate": 120_000, // 要跑一轮模型生成
    "models.list": 60_000, // 首次初始化 ModelRuntime 可能做网络探测
    "models.catalog": 60_000,
  };

  ipcMain.handle(IPC.hostCommand, async (_e, cmd: HostCommand) => {
    if (!("id" in cmd)) throw new Error("hostCommand requires id");

    // 创建/恢复会话时写入注册表
    if (cmd.type === "session.create") {
      const now = Date.now();
      registry.upsert({
        id: cmd.payload.sessionId,
        mode: cmd.payload.mode,
        cwd: cmd.payload.cwd,
        title: cmd.payload.mode === "chat" ? "新聊天" : baseName(cmd.payload.cwd) || "新项目",
        model: cmd.payload.model ?? settings.get().defaultModel,
        thinkingLevel: cmd.payload.thinkingLevel ?? settings.get().defaultThinkingLevel,
        sessionFile: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    // 兜底标题：标题还是出厂默认时，用首条用户消息推导（AI RenameSession 之后可覆盖）
    if (cmd.type === "session.prompt") {
      const entry = registry.get(cmd.payload.sessionId);
      if (entry && isDefaultTitle(entry.title, entry.cwd)) {
        const title = cleanSessionTitle(cmd.payload.text);
        if (title) registry.patch(entry.id, { title, updatedAt: Date.now() });
      }
    }

    // 恢复会话：把注册表里的计划模式状态捎带给宿主（渲染进程不感知这个字段）
    if (cmd.type === "session.open") {
      cmd.payload.planMode = registry.get(cmd.payload.sessionId)?.planMode ?? false;
    }

    return bridge.call(cmd, { timeoutMs: CALL_TIMEOUTS[cmd.type] }).then((result) => {
      backfillSessionFile(cmd, result, registry);
      return result;
    });
  });

  ipcMain.on(IPC.permissionReply, (_e, payload: { requestId: string; approved: boolean }) => {
    bridge.replyPermission(payload.requestId, payload.approved);
  });

  ipcMain.on(IPC.questionReply, (_e, payload: { requestId: string; answers: Record<string, string> }) => {
    bridge.replyQuestion(payload.requestId, payload.answers);
  });

  ipcMain.handle(IPC.listSessions, () => registry.list());
  ipcMain.handle(IPC.searchSessions, (_e, query: string) => searchSessions(registry.list(), String(query ?? "")));

  // 定时任务 CRUD + 立即试运行
  ipcMain.handle(IPC.scheduleList, () => scheduler.list());
  ipcMain.handle(IPC.scheduleCreate, (_e, input: ScheduleTaskInput) => scheduler.create(input));
  ipcMain.handle(IPC.scheduleUpdate, (_e, id: string, patch: Partial<ScheduleTaskInput>) =>
    scheduler.update(id, patch),
  );
  ipcMain.handle(IPC.scheduleDelete, (_e, id: string) => scheduler.remove(id));
  ipcMain.handle(IPC.scheduleRunNow, (_e, id: string) => scheduler.runNow(id));
  ipcMain.handle(IPC.removeSession, (_e, id: string) =>
    removeSessionEverywhere({ registry, bridge, events: bridge }, id),
  );

  ipcMain.handle(IPC.usageSummary, (_e, days?: number) => ledger.summarize(days ?? 14));
  ipcMain.handle(IPC.usageAggregate, (_e, range: "today" | "week" | "all") => ledger.aggregateRange(range ?? "week"));
  ipcMain.handle(IPC.quotaQuery, (_e, force?: boolean) => quota.queryAll({ force: force === true }));

  ipcMain.handle(IPC.revealPath, (_e, p: string) => {
    if (typeof p === "string" && p.trim()) shell.showItemInFolder(p);
  });

  ipcMain.handle(IPC.pickDirectory, async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
      title: "选择项目文件夹",
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // 图片附件：多选，读成 base64 内联（>10MB 的跳过，避免撑爆上下文）
  ipcMain.handle(IPC.pickImages, async () => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
      title: "添加图片附件",
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
    });
    if (result.canceled) return [];
    const out: { name: string; mimeType: string; data: string }[] = [];
    for (const file of result.filePaths) {
      try {
        const buf = readFileSync(file);
        if (buf.byteLength > 10 * 1024 * 1024) continue;
        const ext = basename(file).split(".").pop()?.toLowerCase() ?? "png";
        const mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        out.push({ name: basename(file), mimeType, data: buf.toString("base64") });
      } catch {
        // 单个文件读取失败不阻塞其它
      }
    }
    return out;
  });

  ipcMain.handle(IPC.getSettings, () => settings.get());
  ipcMain.handle(IPC.setSettings, (_e, patch: Partial<AppSettings>) => {
    const next = settings.set(patch);
    // 蒸馏开关实时下发宿主（评审 P0-4：静默计费的开关必须即时生效）
    if ("memoryDistill" in patch) {
      bridge.push({ type: "memory.setDistillEnabled", payload: { enabled: next.memoryDistill } });
    }
    // 高级搜索配置实时下发宿主（对己创建会话不生效，新会话生效——工具列表创建时固定）
    if ("advancedSearch" in patch) {
      bridge.push({ type: "search.setAdvancedConfig", payload: { config: next.advancedSearch } });
    }
    // 远程控制开关/端口变更：即时启停（改动最小的方式——由 IPC 层显式触发）
    if ("remote" in patch) {
      void remote.applySettings();
    }
    return next;
  });

  // 远程控制：状态查询 / 开关 / 重新生成配对 QR / 解绑设备
  ipcMain.handle(IPC.remoteStatus, () => remote.status());
  ipcMain.handle(IPC.remoteSetEnabled, async (_e, enabled: boolean, port?: number | null) => {
    const cur = settings.get().remote;
    settings.set({
      remote: {
        enabled: enabled === true,
        port: typeof port === "number" ? port : port === null ? null : cur.port,
        relayUrl: cur.relayUrl ?? null,
      },
    });
    await remote.applySettings();
    return remote.status();
  });
  ipcMain.handle(IPC.remoteRegeneratePairing, () => remote.regeneratePairing());
  ipcMain.handle(IPC.remoteUnpairDevice, (_e, deviceId: string) => remote.unpairDevice(deviceId));

  // 高级搜索「测试连接」：主进程发真实请求，返回成功条数或失败原因（渲染进程直连会撞 CSP/CORS）
  ipcMain.handle(IPC.searchTest, async (_e, config: AdvancedSearchConfig) => {
    if (!isAdvancedSearchReady(config)) return { ok: false as const, error: "配置不完整（baseUrl / apiKey / 响应映射）" };
    try {
      const results = await executeSearch(config, "test", 3, 15_000);
      return { ok: true as const, count: results.length };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 字体：选择字体文件 → 复制进 ~/.spcode/fonts/，返回 { file, family }
  ipcMain.handle(IPC.pickFontFile, async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      title: "选择字体文件",
      filters: [{ name: "字体", extensions: ["ttf", "otf", "woff", "woff2"] }],
    });
    const src = result.canceled ? null : (result.filePaths[0] ?? null);
    if (!src) return null;
    const fontsDir = join(resolveSpcodeHome(), "fonts");
    mkdirSync(fontsDir, { recursive: true });
    const file = basename(src);
    copyFileSync(src, join(fontsDir, file));
    const family = file.replace(/\.(ttf|otf|woff2?)$/i, "").replace(/[\s_-]+/g, " ");
    return { file, family };
  });

  // 字体数据：FontFace 注册用（只允许读 fonts 目录内的文件）
  ipcMain.handle(IPC.getFontData, (_e, fileName: string) => {
    const fontsDir = join(resolveSpcodeHome(), "fonts");
    const file = join(fontsDir, basename(fileName));
    if (!existsSync(file)) return null;
    return readFileSync(file);
  });

  // 主题：选择主题 JSON 文件，返回文本内容（校验在渲染进程做）
  ipcMain.handle(IPC.pickThemeFile, async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      title: "导入主题 JSON",
      filters: [{ name: "主题", extensions: ["json"] }],
    });
    const src = result.canceled ? null : (result.filePaths[0] ?? null);
    if (!src) return null;
    try {
      return readFileSync(src, "utf-8");
    } catch {
      return null;
    }
  });
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

// 单实例锁：~/.spcode 的 sessions/settings/schedules 都是「读-改-写」内存缓存模型，
// 双开会让两个实例互相整文件覆盖，必须挡在启动前
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    registerIpc();
    watchSessionLifecycle();
    // 宿主每次 ready（含崩溃重启后）都重推一次运行时设置
    bridge.onEvent((event) => {
      if (event.type === "ready") {
        bridge.push({ type: "memory.setDistillEnabled", payload: { enabled: settings.get().memoryDistill } });
        bridge.push({ type: "search.setAdvancedConfig", payload: { config: settings.get().advancedSearch } });
      }
    });
    await bridge.start();
    scheduler.start();
    // settings.remote.enabled 时启动局域网 HTTP+WS 服务（未启用则空操作）
    await remote.applySettings();
    createWindow();
    setupAutoUpdater(
      () => settings.get().autoUpdate,
      () => mainWindow,
    );

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void remote.stop();
  void bridge.dispose();
});

export type { SessionMode };
