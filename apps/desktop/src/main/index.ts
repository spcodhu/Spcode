/**
 * Spcode 主进程入口：窗口、IPC、会话注册表、定时任务调度、自动更新（未配置更新源时静默跳过）。
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { IPC, SPCODE_HOME_DIRNAME, cleanSessionTitle, type AppSettings, type HostCommand, type HostEvent, type ScheduleTask, type ScheduleTaskInput, type SessionMode } from "@spcode/shared";
import { AgentBridge } from "./agent-bridge.js";
import { QuotaService } from "./quota-service.js";
import { Scheduler } from "./scheduler.js";
import { searchSessions } from "./session-search.js";
import { SessionRegistry } from "./session-registry.js";
import { SettingsStore } from "./settings-store.js";
import { UsageLedger } from "./usage-ledger.js";
import { setupAutoUpdater } from "./updater.js";

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

/** 判断标题是否仍是出厂默认（「新聊天」/「新项目」/目录名），是则允许用首条用户消息兜底 */
function isDefaultTitle(title: string, cwd: string): boolean {
  return title === "新聊天" || title === "新项目" || title === (cwd.split("/").pop() ?? "");
}

/** 会话创建/恢复成功后回填 sessionFile 到注册表（支撑下次恢复） */
function backfillSessionFile(
  cmd: HostCommand,
  result: unknown,
): void {
  if (cmd.type !== "session.create" && cmd.type !== "session.open") return;
  const data = result as
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
}

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
  backfillSessionFile(createCmd, info);
  await bridge.call(
    AgentBridge.withId({ type: "session.prompt", payload: { sessionId, text: task.prompt } }),
  );
  return sessionId;
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

    return bridge.call(cmd).then((result) => {
      backfillSessionFile(cmd, result);
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
  ipcMain.handle(IPC.scheduleUpdate, (_e, id: string, patch: Partial<ScheduleTaskInput>) => scheduler.update(id, patch));
  ipcMain.handle(IPC.scheduleDelete, (_e, id: string) => scheduler.remove(id));
  ipcMain.handle(IPC.scheduleRunNow, (_e, id: string) => scheduler.runNow(id));
  ipcMain.handle(IPC.removeSession, (_e, id: string) => {
    registry.remove(id);
    // 计划文件（~/.spcode/plans/<id>.md）随会话一并清理
    rmSync(join(homedir(), SPCODE_HOME_DIRNAME, "plans", `${id}.md`), { force: true });
    // 宿主里的活跃实例也一并释放
    void bridge
      .call({ id: `dispose-${id}`, type: "session.dispose", payload: { sessionId: id } })
      .catch(() => {});
  });

  ipcMain.handle(IPC.usageSummary, (_e, days?: number) => ledger.summarize(days ?? 14));
  ipcMain.handle(IPC.usageAggregate, (_e, range: "today" | "week" | "all") => ledger.aggregateRange(range ?? "week"));
  ipcMain.handle(IPC.quotaQuery, () => quota.queryAll());

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
  ipcMain.handle(IPC.setSettings, (_e, patch: Partial<AppSettings>) => settings.set(patch));

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
    const fontsDir = join(homedir(), SPCODE_HOME_DIRNAME, "fonts");
    mkdirSync(fontsDir, { recursive: true });
    const file = basename(src);
    copyFileSync(src, join(fontsDir, file));
    const family = file.replace(/\.(ttf|otf|woff2?)$/i, "").replace(/[\s_-]+/g, " ");
    return { file, family };
  });

  // 字体数据：FontFace 注册用（只允许读 fonts 目录内的文件）
  ipcMain.handle(IPC.getFontData, (_e, fileName: string) => {
    const fontsDir = join(homedir(), SPCODE_HOME_DIRNAME, "fonts");
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

void app.whenReady().then(async () => {
  registerIpc();
  watchSessionLifecycle();
  await bridge.start();
  scheduler.start();
  createWindow();
  setupAutoUpdater(() => settings.get().autoUpdate);

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
