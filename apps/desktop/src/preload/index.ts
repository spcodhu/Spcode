/**
 * Preload：渲染进程唯一的能力入口，白名单式暴露。
 */
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type AppSettings, type HostCommandInput, type HostEvent } from "@spcode/shared";
import type { SessionRegistryEntry } from "../main/session-registry.js";
import type { QuotaInfo } from "../main/quota-service.js";
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
  /** 用量聚合（按日×模型）与厂商配额 */
  usageSummary(days?: number): Promise<DailyUsage[]>;
  quotaQuery(): Promise<QuotaInfo[]>;
  /** 选择项目文件夹 */
  pickDirectory(): Promise<string | null>;
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
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
  usageSummary(days) {
    return ipcRenderer.invoke(IPC.usageSummary, days);
  },
  quotaQuery() {
    return ipcRenderer.invoke(IPC.quotaQuery);
  },
  pickDirectory() {
    return ipcRenderer.invoke(IPC.pickDirectory);
  },
  getSettings() {
    return ipcRenderer.invoke(IPC.getSettings);
  },
  setSettings(patch) {
    return ipcRenderer.invoke(IPC.setSettings, patch);
  },
};

contextBridge.exposeInMainWorld("spcode", api);
