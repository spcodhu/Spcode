/**
 * Spcode 主进程入口：窗口、IPC、会话注册表、定时任务调度、自动更新（未配置更新源时静默跳过）。
 */

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type AdvancedSearchConfig,
  type AppSettings,
  baseName,
  type ComposerDraft,
  cleanSessionTitle,
  deriveProjectPermissionRule,
  type HostCommand,
  type HostCommandInput,
  type HostEvent,
  IPC,
  normalizeProjectCwd,
  type PickedFile,
  type SandboxStatusReport,
  type ScheduleTask,
  type ScheduleTaskInput,
  SECRET_MASK,
  type SessionMode,
  type WebFetchConfig,
} from "@spcode/shared";
import { executeSearch, isAdvancedSearchReady } from "@spcode/shared/advanced-search";
import { i18n, setLocale } from "@spcode/shared/i18n";
import { resolveSpcodeHome } from "@spcode/shared/node";
import { executeFetch, isWebFetchReady } from "@spcode/shared/web-fetch";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { AgentBridge } from "./agent-bridge.js";
import { DraftsStore } from "./drafts-store.js";
import { showImageContextMenu } from "./image-actions.js";
import { Notifier } from "./notifier.js";
import { readSessionPlan } from "./plan-file.js";
import { QuotaService } from "./quota-service.js";
import { RemoteServer } from "./remote/index.js";
import { Scheduler } from "./scheduler.js";
import { type GitBaseline, gitBaseline, gitDiff, gitStashPush, gitStatusPorcelain, hasChanges } from "./session-git.js";
import {
  backfillSessionFile,
  buildForkRegistryEntry,
  isDefaultTitle,
  prepareForkCommand,
  removeSession as removeSessionEverywhere,
} from "./session-helpers.js";
import { SessionRegistry } from "./session-registry.js";
import { searchSessions } from "./session-search.js";
import { redactSettingsForRenderer, restoreMaskedSecrets, SettingsStore } from "./settings-store.js";
import { downloadUpdate, getUpdateState, ignoreVersion, installUpdate, setupAutoUpdater } from "./updater.js";
import { UsageLedger } from "./usage-ledger.js";

/** pickFiles 的文本文件扩展名白名单（不在名单内的靠二进制唿探判决） */
const PICK_TEXT_EXTS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "xml",
  "csv",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "java",
  "go",
  "rs",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "rb",
  "php",
  "swift",
  "kt",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "sql",
  "html",
  "css",
  "scss",
  "less",
  "vue",
  "svelte",
  "ini",
  "conf",
  "log",
]);
const PICK_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

/** 二进制唿探：前 8000 字节内出现 NUL 即视为二进制 */
function looksBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, Math.min(buf.length, 8000));
  return head.includes(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// 开发模式没有 bundle 图标：macOS Dock / Windows 任务栏会退回 Electron 默认图标，
// 这里运行时指向 build/icon.png 补上；打包后图标来自 Info.plist 的 icon.icns 与
// exe 资源，该路径在包内不存在，自动跳过
const devIconPath = join(__dirname, "../../build/icon.png");
const devIcon = !app.isPackaged && existsSync(devIconPath) ? devIconPath : undefined;

const settings = new SettingsStore();
setLocale(settings.get().locale);
const draftsStore = new DraftsStore();
const registry = new SessionRegistry();
const ledger = new UsageLedger();
/** 会话 git 基线（评审 R3-F2）：项目会话首次 prompt 前记录，驱动「查看改动/还原」 */
const gitBaselines = new Map<string, GitBaseline>();
const quota = new QuotaService(undefined, (providerId) => ledger.providerUsage(providerId));
const bridge = new AgentBridge({
  getPermissionRules: () => settings.get().permissionRules,
  getProjectPermissionRules: (request) =>
    settings.get().projectPermissionRules[normalizeProjectCwd(request.cwd ?? "")] ?? [],
});
/** 桌面通知（R3-F4）：窗口未聚焦时的审批/提问/长任务完成提醒 + Dock 徽标 */
const notifier = new Notifier({
  isEnabled: () => settings.get().desktopNotifications !== false,
  getWindow: () => mainWindow,
  openSession: (sessionId) => bridge.emitLocal({ type: "session.focus", sessionId }),
});

let mainWindow: BrowserWindow | null = null;
/** E2E 后台模式：窗口不显示不抢焦点（只由 e2e/helpers.ts 设置） */
const backgroundE2E = process.env.SPCODE_E2E_BACKGROUND === "1";

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "Spcod",
    ...(devIcon ? { icon: devIcon } : {}),
    backgroundColor: "#0b0f14",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    show: !backgroundE2E,
    focusable: !backgroundE2E,
    skipTaskbar: backgroundE2E,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      // 隐藏窗口仍需持续渲染/计时，否则 Playwright 交互会被后台节流拖慢
      backgroundThrottling: !backgroundE2E,
      // 评审 R3-C6：preload 只用 ipcRenderer/contextBridge（命令 id 已挪主进程补发），
      // 可以安全开启沙箱——被劫持的渲染层不再有 Node 能力
      sandbox: true,
    },
  });

  // 安全：外链一律转外部浏览器打开，不允许新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // 安全：拦截渲染进程内导航（模型输出的 Markdown 链接同窗点击会导航走本窗口，
  // 远程页面将继承 preload 能力）。只放行应用自身入口文件与 dev server——
  // 任意 file:// 一律拦（评审 R3-C6：本地恶意 HTML 不能继承 preload）。
  const allowedEntryUrl = pathToFileURL(join(__dirname, "../renderer/index.html")).href;
  mainWindow.webContents.on("will-navigate", (e, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (url === allowedEntryUrl || (devUrl && url.startsWith(devUrl))) return;
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
    // 通知（R3-F4）：审批/提问到达与结清、长任务完成
    if (event.type === "permission.request") {
      notifier.notifyApprovalNeeded(
        "permission",
        event.request.requestId,
        i18n.t("integration:notifications.approvalForSession", {
          tool: event.request.toolName,
          title: registry.get(event.request.sessionId)?.title ?? event.request.sessionId,
        }),
        event.request.sessionId,
      );
      return;
    }
    if (event.type === "permission.resolved") {
      notifier.resolveApproval(event.requestId);
      return;
    }
    if (event.type === "question.request") {
      notifier.notifyApprovalNeeded(
        "question",
        event.request.requestId,
        i18n.t("integration:notifications.questionForSession", {
          title: registry.get(event.request.sessionId)?.title ?? event.request.sessionId,
        }),
        event.request.sessionId,
      );
      return;
    }
    if (event.type === "question.resolved") {
      notifier.resolveApproval(event.requestId);
      return;
    }
    if (event.type === "session.event") {
      notifier.noteSessionEvent(event.sessionId, event.event as { type?: string });
    }
    // 用量落账
    if (event.type === "session.usage") {
      ledger.append(event.usage);
      return;
    }
    // AI 通过 RenameSession 起的标题：持久化到注册表（渲染进程由广播自行更新）
    if (event.type === "session.renamed") {
      registry.patch(event.sessionId, { title: event.title, titleKind: "custom", updatedAt: Date.now() });
      return;
    }
    // 计划模式开关：持久化到注册表（恢复会话时据此还原计划态）
    if (event.type === "session.planmode") {
      registry.patch(event.sessionId, { planMode: event.enabled });
      return;
    }
    // 权限模式切换：持久化到注册表（重开/唤醒会话时据此还原档位）
    if (event.type === "session.permissionmode") {
      registry.patch(event.sessionId, { permissionMode: event.mode });
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
    titleKind: "custom",
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

const remote = new RemoteServer({
  settings,
  bridge,
  scheduler,
  registry,
  mobileRuntime: {
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
  },
  onLanPortBound: (port) => {
    const current = settings.get().remote;
    if (current.port === null) settings.set({ remote: { ...current, port } });
  },
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
  // 长调用命令的超时覆盖（bridge.call 默认 30s——评审 P1-8）
  const CALL_TIMEOUTS: Partial<Record<HostCommand["type"], number>> = {
    "theme.generate": 120_000, // 要跑一轮模型生成
    "models.list": 60_000, // 首次初始化 ModelRuntime 可能做网络探测
    "models.catalog": 60_000,
    "models.addModel": 60_000, // 内部触发 ModelRuntime 首次初始化 + rebuildProviders
    "models.removeModel": 60_000,
    "session.compact": 180_000, // 评审 R3-C11：LLM 压缩大上下文常超 30s（压缩实际会继续，误报错误最迷惑）
  };

  ipcMain.handle(IPC.hostCommand, async (_e, raw: HostCommandInput) => {
    // id 统一在这里补发（preload 不生成；评审 R3-C6）
    const id = "id" in raw && typeof raw.id === "string" && raw.id ? raw.id : randomUUID();
    const cmd = { ...raw, id } as Extract<HostCommand, { id: string }>;

    // 创建/恢复会话时写入注册表
    if (cmd.type === "session.create") {
      const now = Date.now();
      // 新会话继承设置页的默认档位（单会话随后可在输入框覆盖）
      cmd.payload.permissionMode = cmd.payload.permissionMode ?? settings.get().permissionMode;
      registry.upsert({
        id: cmd.payload.sessionId,
        mode: cmd.payload.mode,
        cwd: cmd.payload.cwd,
        title:
          cmd.payload.mode === "chat"
            ? i18n.t("common:newChat")
            : baseName(cmd.payload.cwd) || i18n.t("common:newProject"),
        titleKind: "default",
        model: cmd.payload.model ?? settings.get().defaultModel,
        thinkingLevel: cmd.payload.thinkingLevel ?? settings.get().defaultThinkingLevel,
        permissionMode: cmd.payload.permissionMode,
        sessionFile: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    // 兜底标题：标题还是出厂默认时，用首条用户消息推导（AI RenameSession 之后可覆盖）
    if (cmd.type === "session.prompt") {
      const entry = registry.get(cmd.payload.sessionId);
      if (entry && isDefaultTitle(entry.title, entry.cwd, entry.titleKind)) {
        const title = cleanSessionTitle(cmd.payload.text);
        if (title) registry.patch(entry.id, { title, titleKind: "custom", updatedAt: Date.now() });
      }
      // 评审 R3-F2：项目会话首次 prompt 前记 git 基线（会话级「还原到会话开始前」的锚点）
      if (entry?.cwd && !gitBaselines.has(cmd.payload.sessionId)) {
        void gitBaseline(entry.cwd).then((base) => {
          if (base && !gitBaselines.has(cmd.payload.sessionId)) gitBaselines.set(cmd.payload.sessionId, base);
        });
      }
    }

    // 恢复/唤醒会话：把注册表里的计划模式状态捎带给宿主（渲染进程不感知这个字段）
    if (cmd.type === "session.open" || cmd.type === "session.activate") {
      const entry = registry.get(cmd.payload.sessionId);
      cmd.payload.planMode = entry?.planMode ?? false;
      cmd.payload.permissionMode = entry?.permissionMode ?? settings.get().permissionMode;
    }

    // Fork 会话：渲染层只传 sourceSessionId/newSessionId 与可选项，
    // 源会话的 sessionFile/cwd/mode 与缺省继承的 model/thinkingLevel/planMode 在这里补齐
    if (cmd.type === "session.fork") {
      const prepared = prepareForkCommand(registry, cmd.payload);
      if (!prepared.ok) throw new Error(prepared.error);
      cmd.payload = prepared.payload;
    }

    // 导出会话上下文：渲染层只传 sessionId，sessionFile/cwd/title 从注册表补齐
    if (cmd.type === "session.exportContext") {
      const entry = registry.get(cmd.payload.sessionId);
      if (!entry) throw new Error(i18n.t("integration:session.missing", { id: cmd.payload.sessionId }));
      cmd.payload.sessionFile = entry.sessionFile ?? undefined;
      cmd.payload.cwd = entry.cwd;
      cmd.payload.title = entry.title;
    }

    return bridge.call(cmd, { timeoutMs: CALL_TIMEOUTS[cmd.type] }).then((result) => {
      // Fork 成功：注册表写入新条目（标题后缀/继承关系见 buildForkRegistryEntry），广播列表刷新
      if (cmd.type === "session.fork") {
        const source = registry.get(cmd.payload.sourceSessionId);
        if (source) {
          registry.upsert(buildForkRegistryEntry(source, cmd.payload));
          bridge.emitLocal({ type: "sessions.changed" });
        }
      }
      backfillSessionFile(cmd, result, registry);
      return result;
    });
  });

  ipcMain.on(
    IPC.permissionReply,
    (_e, payload: { requestId: string; approved: boolean; rememberProject?: boolean }) => {
      if (payload.approved && payload.rememberProject) {
        const request = bridge.getPendingPermission(payload.requestId);
        const rule = request ? deriveProjectPermissionRule(request) : null;
        const cwd = normalizeProjectCwd(request?.cwd ?? "");
        if (rule && cwd) {
          const current = settings.get().projectPermissionRules;
          const rules = current[cwd] ?? [];
          const exists = rules.some((r) => r.command === rule.command && r.match === rule.match);
          if (!exists) {
            // 主进程同步落盘后再批准：当前与后续会话共用同一项目规则，且无渲染层保存竞态。
            settings.set({ projectPermissionRules: { ...current, [cwd]: [...rules, rule] } });
          }
        }
      }
      bridge.replyPermission(payload.requestId, payload.approved);
    },
  );

  ipcMain.on(
    IPC.questionReply,
    (_e, payload: { requestId: string; answers: import("@spcode/shared").QuestionAnswers }) => {
      bridge.replyQuestion(payload.requestId, payload.answers);
    },
  );

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
  ipcMain.handle(IPC.removeSession, (_e, id: string) => {
    gitBaselines.delete(id);
    return removeSessionEverywhere({ registry, bridge, events: bridge }, id);
  });

  // 评审 R3-F2：会话 git 改动查看/还原（仅项目会话；基线不存在 = 非 git 仓库或 chat 会话）
  ipcMain.handle(IPC.sessionGitState, async (_e, id: string) => {
    const entry = registry.get(id);
    const base = gitBaselines.get(id);
    if (!entry?.cwd || !base) return { hasBaseline: false, changed: false, stat: "" };
    const cur = await gitStatusPorcelain(entry.cwd);
    if (cur === null) return { hasBaseline: true, changed: false, stat: "" };
    const changed = hasChanges(base, cur);
    let stat = "";
    if (changed) stat = (await gitDiff(entry.cwd))?.stat ?? "";
    return { hasBaseline: true, changed, stat };
  });
  ipcMain.handle(IPC.sessionGitDiff, async (_e, id: string) => {
    const entry = registry.get(id);
    if (!entry?.cwd || !gitBaselines.has(id)) return null;
    return gitDiff(entry.cwd);
  });
  ipcMain.handle(IPC.sessionGitRevert, async (_e, id: string) => {
    const entry = registry.get(id);
    if (!entry?.cwd || !gitBaselines.has(id)) return null;
    // 还原 = stash push（可恢复）：改动进 stash，git stash pop 可找回
    const out = await gitStashPush(entry.cwd, `spcode rewind: ${entry.title} @${new Date().toISOString()}`);
    return out;
  });

  ipcMain.handle(IPC.usageSummary, (_e, days?: number) => ledger.summarize(days ?? 14));
  ipcMain.handle(IPC.usageAggregate, (_e, range: "today" | "week" | "all") => ledger.aggregateRange(range ?? "week"));
  ipcMain.handle(IPC.quotaQuery, (_e, force?: boolean) => quota.queryAll({ force: force === true }));

  // 沙盒运行状态：经 agent-host 查询（SandboxManager 只存在于宿主进程）。
  // 首次查询会惰性初始化沙盒（1–2s），故单独设 10s 超时；失败降级为带原因的 unavailable。
  ipcMain.handle(IPC.sandboxStatus, async (): Promise<SandboxStatusReport> => {
    const snapshot = settings.get().sandbox;
    const fallback = {
      enabled: snapshot.enabled,
      allowUnsandboxedCommands: snapshot.allowUnsandboxedCommands,
      platform: process.platform,
    };
    try {
      return await bridge.call<SandboxStatusReport>(AgentBridge.withId({ type: "sandbox.status" }), {
        timeoutMs: 10_000,
      });
    } catch (err) {
      return {
        ...fallback,
        state: snapshot.enabled ? "unavailable" : "disabled",
        reason: snapshot.enabled
          ? i18n.t("integration:sandbox.hostUnavailable", { error: err instanceof Error ? err.message : String(err) })
          : i18n.t("integration:sandbox.disabled"),
      };
    }
  });

  ipcMain.handle(IPC.revealPath, (_e, p: string) => {
    if (typeof p === "string" && p.trim()) shell.showItemInFolder(p);
  });

  ipcMain.handle(IPC.pickDirectory, async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
      title: i18n.t("integration:files.project"),
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // 图片附件：多选，读成 base64 内联（>10MB 的跳过，避免撑爆上下文）
  ipcMain.handle(IPC.imageContextMenu, showImageContextMenu);
  ipcMain.handle(IPC.pickImages, async () => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
      title: i18n.t("integration:files.addImages"),
      filters: [{ name: i18n.t("integration:files.images"), extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
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

  // 任意文件选择（Markdown 输入模式「添加文件」）：文本类读 utf-8 内容，图片转图片附件，
  // 二进制/超大标 rejected 由渲染层提示（引擎 prompt 只支持文本+图片，文件内容随文本发出）
  ipcMain.handle(IPC.pickFiles, async (): Promise<PickedFile[]> => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
      title: i18n.t("integration:files.add"),
    });
    if (result.canceled) return [];
    const out: PickedFile[] = [];
    for (const file of result.filePaths) {
      const name = basename(file);
      const ext = name.includes(".") ? (name.split(".").pop()?.toLowerCase() ?? "") : "";
      try {
        // 先 stat 后读（评审 R3-C15：原实现先 readFileSync 再判大小，2GB 文件直接卡死主进程）
        const size = statSync(file).size;
        if (PICK_IMAGE_EXTS.has(ext)) {
          if (size > 10 * 1024 * 1024) {
            out.push({ kind: "rejected", name, size, reason: i18n.t("integration:files.largeImage") });
            continue;
          }
          const buf = readFileSync(file);
          const mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
          out.push({ kind: "image", name, mimeType, data: buf.toString("base64") });
          continue;
        }
        if (size > 200 * 1024) {
          out.push({ kind: "rejected", name, size, reason: i18n.t("integration:files.largeText") });
          continue;
        }
        const buf = readFileSync(file);
        if (PICK_TEXT_EXTS.has(ext) || !looksBinary(buf)) {
          out.push({ kind: "text", name, size, text: buf.toString("utf-8") });
        } else {
          out.push({ kind: "rejected", name, size, reason: i18n.t("integration:files.binary") });
        }
      } catch {
        out.push({ kind: "rejected", name, size: 0, reason: i18n.t("integration:files.readFailed") });
      }
    }
    return out;
  });

  // 输入框草稿：全量读/写（渲染层防抖 500ms 保存；内容全空的 key 已被渲染层剔除）
  ipcMain.handle(IPC.getComposerDrafts, () => draftsStore.get());
  ipcMain.handle(IPC.setComposerDrafts, (_e, drafts: Record<string, ComposerDraft>) => {
    draftsStore.set(drafts && typeof drafts === "object" ? drafts : {});
  });

  ipcMain.handle(IPC.getSettings, () => redactSettingsForRenderer(settings.get()));
  ipcMain.handle(IPC.planRead, (_e, path: string) => readSessionPlan(String(path)));
  ipcMain.handle(IPC.getAppVersion, () => app.getVersion());

  // 更新：状态查询 / 手动下载 / 重启安装 / 忽略版本（状态推送见 setupAutoUpdater 的 onState）
  ipcMain.handle(IPC.updateGetState, () => getUpdateState());
  ipcMain.handle(IPC.updateDownload, () => downloadUpdate());
  ipcMain.handle(IPC.updateInstall, () => installUpdate());
  ipcMain.handle(IPC.updateIgnore, (_e, version: string) => {
    settings.set({ ignoredUpdateVersion: version });
    ignoreVersion();
  });
  ipcMain.handle(IPC.setSettings, (_e, patch: Partial<AppSettings>) => {
    // 掩码密钥还原（渲染层只见过掩码；评审 R3-C8）
    const next = settings.set(restoreMaskedSecrets(patch, settings.get()));
    if ("locale" in patch) {
      setLocale(next.locale);
      bridge.push({ type: "locale.set", payload: { locale: next.locale } });
      bridge.emitLocal({ type: "locale.changed", locale: next.locale });
      remote.setLocale(next.locale);
    }
    // 蒸馏开关实时下发宿主（评审 P0-4：静默计费的开关必须即时生效）
    if ("memoryDistill" in patch) {
      bridge.push({ type: "memory.setDistillEnabled", payload: { enabled: next.memoryDistill } });
    }
    // 高级搜索配置实时下发宿主（对己创建会话不生效，新会话生效——工具列表创建时固定）
    if ("advancedSearch" in patch) {
      bridge.push({ type: "search.setAdvancedConfig", payload: { config: next.advancedSearch } });
    }
    // WebFetch 抓取后端实时下发宿主（工具逐次调用实时读取，活跃会话即时生效）
    if ("webFetch" in patch) {
      bridge.push({ type: "webfetch.setConfig", payload: { config: next.webFetch } });
    }
    // 沙盒设置实时下发宿主（对已创建会话不生效，新会话生效——bash 工具注册在会话创建时固定）
    if ("sandbox" in patch) {
      bridge.push({ type: "sandbox.setConfig", payload: { config: next.sandbox } });
    }
    // 压缩设置实时下发宿主（引擎每次压缩判断都实时读 SettingsManager，活跃会话即时生效）
    if ("compaction" in patch) {
      bridge.push({ type: "compaction.setConfig", payload: { config: next.compaction } });
    }
    // MCP 服务器配置实时下发宿主（对已创建会话不生效，新会话生效——工具列表创建时固定）
    if ("mcpServers" in patch) {
      bridge.push({ type: "mcp.setServers", payload: { servers: next.mcpServers } });
    }
    // 远程控制开关/端口变更：即时启停（改动最小的方式——由 IPC 层显式触发）
    if ("remote" in patch) {
      void remote.applySettings();
    }
    return redactSettingsForRenderer(next);
  });

  // 远程控制：状态查询 / 开关 / 重新生成配对 QR / 解绑设备
  ipcMain.handle(IPC.remoteStatus, async () => {
    // 设置页展示 tailscale 可用性前刷新一次检测（内部 15s 缓存，不频繁 spawn）
    await remote.refreshTailscaleDetection();
    return remote.status();
  });
  ipcMain.handle(IPC.remoteSetEnabled, async (_e, enabled: boolean, port?: number | null) => {
    const cur = settings.get().remote;
    settings.set({
      remote: {
        ...cur, // 保留 relayUrl / tailscale / pushEnabled 等其余字段
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
  // 飞书通道（M4）：解绑授权用户；状态/绑定验证码走 remoteStatus，配置走 setSettings(remote.feishu)
  ipcMain.handle(IPC.remoteFeishuUnbind, (_e, openId: string) => remote.unbindFeishuUser(openId));

  // 高级搜索「测试连接」：主进程发真实请求，返回成功条数或失败原因（渲染进程直连会撞 CSP/CORS）
  ipcMain.handle(IPC.searchTest, async (_e, config: AdvancedSearchConfig) => {
    // 掩码密钥还原（渲染层拿到的是掩码，原样回传时用存储的真值——评审 R3-C8）
    const resolved =
      config.apiKey === SECRET_MASK ? { ...config, apiKey: settings.get().advancedSearch?.apiKey ?? "" } : config;
    if (!isAdvancedSearchReady(resolved)) return { ok: false as const, error: i18n.t("integration:search.incomplete") };
    try {
      const results = await executeSearch(resolved, "test", 3, 15_000);
      return { ok: true as const, count: results.length };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // WebFetch 抓取后端「测试连接」：抓固定探针页验证端点/密钥/计费状态
  ipcMain.handle(IPC.webFetchTest, async (_e, config: WebFetchConfig) => {
    // 掩码密钥还原（渲染层拿到的是掩码，原样回传时用存储的真值——同 searchTest）
    const resolved =
      config.apiKey === SECRET_MASK ? { ...config, apiKey: settings.get().webFetch?.apiKey ?? "" } : config;
    if (!isWebFetchReady(resolved)) return { ok: false as const, error: i18n.t("integration:search.incomplete") };
    try {
      const page = await executeFetch(resolved, "https://example.com", 15_000);
      return { ok: true as const, length: page.content.length };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 字体：选择字体文件 → 复制进 ~/.spcode/fonts/，返回 { file, family }
  ipcMain.handle(IPC.pickFontFile, async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      title: i18n.t("integration:files.font"),
      filters: [{ name: i18n.t("integration:files.fonts"), extensions: ["ttf", "otf", "woff", "woff2"] }],
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
      title: i18n.t("integration:files.theme"),
      filters: [{ name: i18n.t("integration:files.themes"), extensions: ["json"] }],
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
    } else {
      // 评审 R3-C15：关窗状态下（macOS）双开第二实例要重建窗口，而不是静默无事发生
      createWindow();
    }
  });

  void app.whenReady().then(async () => {
    // E2E 后台运行：隐藏 Dock 图标，避免启动时抢占前台（仅测试进程）
    if (backgroundE2E) app.dock?.hide();
    // dev 模式 Dock 图标运行时设置（打包版由 bundle 自带，无需也不该走这里）
    if (!backgroundE2E && process.platform === "darwin" && devIcon) app.dock?.setIcon(devIcon);
    registerIpc();
    watchSessionLifecycle();
    // 宿主每次 ready（含崩溃重启后）都重推一次运行时设置
    bridge.onEvent((event) => {
      if (event.type === "ready") {
        bridge.push({ type: "locale.set", payload: { locale: settings.get().locale } });
        bridge.push({ type: "memory.setDistillEnabled", payload: { enabled: settings.get().memoryDistill } });
        bridge.push({ type: "search.setAdvancedConfig", payload: { config: settings.get().advancedSearch } });
        bridge.push({ type: "webfetch.setConfig", payload: { config: settings.get().webFetch } });
        bridge.push({ type: "sandbox.setConfig", payload: { config: settings.get().sandbox } });
        bridge.push({ type: "compaction.setConfig", payload: { config: settings.get().compaction } });
        bridge.push({ type: "mcp.setServers", payload: { servers: settings.get().mcpServers } });
      }
    });
    // 评审 R3-C15：后台服务（宿主/远程）启动失败不能让窗口永远建不起来——窗口先建，服务各自兜底
    try {
      await bridge.start();
    } catch (err) {
      console.error("[main] agent-host startup failed", err);
    }
    scheduler.start();
    try {
      await remote.applySettings();
    } catch (err) {
      console.error("[main] remote service startup failed", err);
    }
    createWindow();
    setupAutoUpdater({
      isEnabled: () => settings.get().autoUpdate,
      getBetaUpdates: () => settings.get().betaUpdates,
      getIgnoredVersion: () => settings.get().ignoredUpdateVersion,
      onState: (s) => {
        if (mainWindow && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send(IPC.updateState, s);
        }
      },
    });

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
