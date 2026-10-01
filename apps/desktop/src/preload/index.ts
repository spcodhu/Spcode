/**
 * Preload：渲染进程唯一的能力入口，白名单式暴露。
 */

import {
  type AdvancedSearchConfig,
  type AppSettings,
  type HostCommandInput,
  type HostEvent,
  IPC,
  type ScheduleTask,
  type ScheduleTaskInput,
  type SessionSearchResultItem,
} from "@spcode/shared";
import { contextBridge, ipcRenderer } from "electron";
import type { QuotaInfo } from "../main/quota-service.js";
import type { SessionRegistryEntry } from "../main/session-registry.js";
import type { DailyUsage } from "../main/usage-ledger.js";

export interface SpcodeApi {
  /** 发送带 id 的宿主命令并等待响应 */
  command<T = unknown>(cmd: HostCommandInput): Promise<T>;
  /** 订阅宿主事件流 */
  onEvent(cb: (event: HostEvent) => void): () => void;
  /** 权限确认回复 */
  replyPermission(requestId: string, approved: boolean): void;
  /** 结构化提问回复（AskUserQuestion 工具） */
  replyQuestion(requestId: string, answers: Record<string, string>): void;
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
  /** 选择项目文件夹 */
  pickDirectory(): Promise<string | null>;
  /** 在 Finder/资源管理器中显示路径 */
  revealPath(path: string): Promise<void>;
  /** 选择图片附件（多选，base64 内联） */
  pickImages(): Promise<{ name: string; mimeType: string; data: string }[]>;
  /** 外观：字体导入/字体数据/主题 JSON 导入 */
  pickFontFile(): Promise<{ file: string; family: string } | null>;
  getFontData(fileName: string): Promise<Uint8Array | null>;
  pickThemeFile(): Promise<string | null>;
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** 高级搜索「测试连接」：主进程发真实请求验证配置 */
  searchTest(config: AdvancedSearchConfig): Promise<{ ok: true; count: number } | { ok: false; error: string }>;
}

const api: SpcodeApi = {
  command(cmd) {
    const id = cmd.id ?? crypto.randomUUID();
    return ipcRenderer.invoke(IPC.hostCommand, { ...cmd, id });
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
  pickDirectory() {
    return ipcRenderer.invoke(IPC.pickDirectory);
  },
  revealPath(path) {
    return ipcRenderer.invoke(IPC.revealPath, path);
  },
  pickImages() {
    return ipcRenderer.invoke(IPC.pickImages);
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
  setSettings(patch) {
    return ipcRenderer.invoke(IPC.setSettings, patch);
  },
  searchTest(config) {
    return ipcRenderer.invoke(IPC.searchTest, config);
  },
};

contextBridge.exposeInMainWorld("spcode", api);
