/**
 * Preload：渲染进程唯一的能力入口，白名单式暴露。
 */

import {
  type AdvancedSearchConfig,
  type AppSettings,
  type ComposerDraft,
  type DailyUsage,
  type HostCommandInput,
  type HostEvent,
  IPC,
  type PickedFile,
  type QuotaInfo,
  type RemotePairingInfo,
  type RemoteStatus,
  type SandboxStatusReport,
  type ScheduleTask,
  type ScheduleTaskInput,
  type SessionRegistryEntry,
  type SessionSearchResultItem,
  type UpdateState,
  type WebFetchConfig,
} from "@spcode/shared";
import { contextBridge, ipcRenderer } from "electron";

export interface SpcodeApi {
  /** 发送带 id 的宿主命令并等待响应 */
  command<T = unknown>(cmd: HostCommandInput): Promise<T>;
  /** 订阅宿主事件流 */
  onEvent(cb: (event: HostEvent) => void): () => void;
  /** 权限确认回复 */
  replyPermission(requestId: string, approved: boolean): void;
  /** 结构化提问回复（AskUserQuestion 工具） */
  replyQuestion(requestId: string, answers: import("@spcode/shared").QuestionAnswers): void;
  /** 会话注册表（跨重启持久化） */
  listSessions(): Promise<SessionRegistryEntry[]>;
  removeSession(id: string): Promise<void>;
  /** 会话标题+正文全文搜索 */
  searchSessions(query: string): Promise<SessionSearchResultItem[]>;
  /** 定时任务 CRUD 与立即试运行 */
  scheduleList(): Promise<ScheduleTask[]>;
  scheduleCreate(input: ScheduleTaskInput): Promise<ScheduleTask>;
  scheduleUpdate(id: string, patch: Partial<ScheduleTaskInput>): Promise<ScheduleTask | null>;
  scheduleDelete(id: string): Promise<void>;
  scheduleRunNow(id: string): Promise<string>;
  /** 用量聚合（按日×模型）与厂商配额 */
  usageSummary(days?: number): Promise<DailyUsage[]>;
  usageAggregate(range: "today" | "week" | "all"): Promise<{
    total: import("@spcode/shared").UsageAggregate;
    byModel: Record<string, import("@spcode/shared").UsageAggregate>;
  }>;
  quotaQuery(force?: boolean): Promise<QuotaInfo[]>;
  /** 沙盒运行状态（设置页展示真实状态与不可用原因） */
  sandboxStatus(): Promise<SandboxStatusReport>;
  /** 选择项目文件夹 */
  pickDirectory(): Promise<string | null>;
  /** 在 Finder/资源管理器中显示路径 */
  revealPath(path: string): Promise<void>;
  /** 选择图片附件（多选，base64 内联） */
  pickImages(): Promise<{ name: string; mimeType: string; data: string }[]>;
  /** 选择任意文件（MD 输入模式）：文本类含内容，图片转附件，二进制/超大标 rejected */
  pickFiles(): Promise<PickedFile[]>;
  /** 输入框草稿：全量读取（启动时）/ 全量保存（防抖） */
  getComposerDrafts(): Promise<Record<string, ComposerDraft>>;
  setComposerDrafts(drafts: Record<string, ComposerDraft>): Promise<void>;
  /** 外观：字体导入/字体数据/主题 JSON 导入 */
  pickFontFile(): Promise<{ file: string; family: string } | null>;
  getFontData(fileName: string): Promise<Uint8Array | null>;
  pickThemeFile(): Promise<string | null>;
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** 应用版本号（设置页更新通道开关展示默认值用） */
  getAppVersion(): Promise<string>;
  /** 高级搜索「测试连接」：主进程发真实请求验证配置 */
  searchTest(config: AdvancedSearchConfig): Promise<{ ok: true; count: number } | { ok: false; error: string }>;
  /** WebFetch 抓取后端「测试连接」：主进程发真实请求验证配置 */
  webFetchTest(config: WebFetchConfig): Promise<{ ok: true; length: number } | { ok: false; error: string }>;
  /** 会话 git 改动（评审 R3-F2）：基线状态 / diff 内容 / 还原（stash push 可恢复） */
  sessionGitState(id: string): Promise<{ hasBaseline: boolean; changed: boolean; stat: string }>;
  sessionGitDiff(id: string): Promise<{ stat: string; patch: string; untracked: string[] } | null>;
  sessionGitRevert(id: string): Promise<string | null>;
  /** 远程控制：状态（开关/监听地址/设备列表/当前配对窗口） */
  remoteStatus(): Promise<RemoteStatus>;
  /** 远程控制开关（可选同时设置端口；null = 随机端口），返回最新状态 */
  remoteSetEnabled(enabled: boolean, port?: number | null): Promise<RemoteStatus>;
  /** 重新生成 OTP 并返回 QR payload（单次有效，5 分钟过期） */
  remoteRegeneratePairing(): Promise<RemotePairingInfo>;
  /** 解绑（吊销）已配对设备 */
  remoteUnpairDevice(deviceId: string): Promise<boolean>;
  /** 飞书通道：解绑授权用户（open_id） */
  remoteFeishuUnbind(openId: string): Promise<boolean>;
  /** 更新：状态查询与订阅 / 手动下载 / 重启安装 / 忽略版本 */
  updateGetState(): Promise<UpdateState>;
  onUpdateState(cb: (state: UpdateState) => void): () => void;
  updateDownload(): Promise<void>;
  updateInstall(): Promise<void>;
  updateIgnore(version: string): Promise<void>;
}

const api: SpcodeApi = {
  command(cmd) {
    // id 由主进程补发（preload 不引 crypto——为 sandbox:true 扫清障碍，评审 R3-C6）
    return ipcRenderer.invoke(IPC.hostCommand, cmd);
  },
  onEvent(cb) {
    const listener = (_e: unknown, event: HostEvent) => cb(event);
    ipcRenderer.on(IPC.hostEvent, listener);
    return () => ipcRenderer.removeListener(IPC.hostEvent, listener);
  },
  replyPermission(requestId, approved) {
    ipcRenderer.send(IPC.permissionReply, { requestId, approved });
  },
  replyQuestion(requestId, answers) {
    ipcRenderer.send(IPC.questionReply, { requestId, answers });
  },
  listSessions() {
    return ipcRenderer.invoke(IPC.listSessions);
  },
  removeSession(id) {
    return ipcRenderer.invoke(IPC.removeSession, id);
  },
  searchSessions(query) {
    return ipcRenderer.invoke(IPC.searchSessions, query);
  },
  scheduleList() {
    return ipcRenderer.invoke(IPC.scheduleList);
  },
  scheduleCreate(input) {
    return ipcRenderer.invoke(IPC.scheduleCreate, input);
  },
  scheduleUpdate(id, patch) {
    return ipcRenderer.invoke(IPC.scheduleUpdate, id, patch);
  },
  scheduleDelete(id) {
    return ipcRenderer.invoke(IPC.scheduleDelete, id);
  },
  scheduleRunNow(id) {
    return ipcRenderer.invoke(IPC.scheduleRunNow, id);
  },
  usageSummary(days) {
    return ipcRenderer.invoke(IPC.usageSummary, days);
  },
  usageAggregate(range) {
    return ipcRenderer.invoke(IPC.usageAggregate, range);
  },
  quotaQuery(force?: boolean) {
    return ipcRenderer.invoke(IPC.quotaQuery, force);
  },
  sandboxStatus() {
    return ipcRenderer.invoke(IPC.sandboxStatus);
  },
  pickDirectory() {
    return ipcRenderer.invoke(IPC.pickDirectory);
  },
  revealPath(path) {
    return ipcRenderer.invoke(IPC.revealPath, path);
  },
  pickImages() {
    return ipcRenderer.invoke(IPC.pickImages);
  },
  pickFiles() {
    return ipcRenderer.invoke(IPC.pickFiles);
  },
  getComposerDrafts() {
    return ipcRenderer.invoke(IPC.getComposerDrafts);
  },
  setComposerDrafts(drafts) {
    return ipcRenderer.invoke(IPC.setComposerDrafts, drafts);
  },
  pickFontFile() {
    return ipcRenderer.invoke(IPC.pickFontFile);
  },
  getFontData(fileName) {
    return ipcRenderer.invoke(IPC.getFontData, fileName);
  },
  pickThemeFile() {
    return ipcRenderer.invoke(IPC.pickThemeFile);
  },
  getSettings() {
    return ipcRenderer.invoke(IPC.getSettings);
  },
  getAppVersion() {
    return ipcRenderer.invoke(IPC.getAppVersion);
  },
  setSettings(patch) {
    return ipcRenderer.invoke(IPC.setSettings, patch);
  },
  searchTest(config) {
    return ipcRenderer.invoke(IPC.searchTest, config);
  },
  webFetchTest(config) {
    return ipcRenderer.invoke(IPC.webFetchTest, config);
  },
  sessionGitState(id) {
    return ipcRenderer.invoke(IPC.sessionGitState, id);
  },
  sessionGitDiff(id) {
    return ipcRenderer.invoke(IPC.sessionGitDiff, id);
  },
  sessionGitRevert(id) {
    return ipcRenderer.invoke(IPC.sessionGitRevert, id);
  },
  remoteStatus() {
    return ipcRenderer.invoke(IPC.remoteStatus);
  },
  remoteSetEnabled(enabled, port) {
    return ipcRenderer.invoke(IPC.remoteSetEnabled, enabled, port);
  },
  remoteRegeneratePairing() {
    return ipcRenderer.invoke(IPC.remoteRegeneratePairing);
  },
  remoteUnpairDevice(deviceId) {
    return ipcRenderer.invoke(IPC.remoteUnpairDevice, deviceId);
  },
  remoteFeishuUnbind(openId) {
    return ipcRenderer.invoke(IPC.remoteFeishuUnbind, openId);
  },
  updateGetState() {
    return ipcRenderer.invoke(IPC.updateGetState);
  },
  onUpdateState(cb) {
    const listener = (_e: unknown, state: UpdateState) => cb(state);
    ipcRenderer.on(IPC.updateState, listener);
    return () => ipcRenderer.removeListener(IPC.updateState, listener);
  },
  updateDownload() {
    return ipcRenderer.invoke(IPC.updateDownload);
  },
  updateInstall() {
    return ipcRenderer.invoke(IPC.updateInstall);
  },
  updateIgnore(version) {
    return ipcRenderer.invoke(IPC.updateIgnore, version);
  },
};

contextBridge.exposeInMainWorld("spcode", api);
