/**
 * Preload：渲染进程唯一的能力入口，白名单式暴露。
 */
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type AppSettings, type HostCommandInput, type HostEvent } from "@spcode/shared";

export interface SpcodeApi {
  /** 发送带 id 的宿主命令并等待响应 */
  command<T = unknown>(cmd: HostCommandInput): Promise<T>;
  /** 订阅宿主事件流 */
  onEvent(cb: (event: HostEvent) => void): () => void;
  /** 权限确认回复 */
  replyPermission(requestId: string, approved: boolean): void;
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
