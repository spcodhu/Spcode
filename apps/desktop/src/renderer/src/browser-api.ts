import type { HostEvent, PickedFile } from "@spcode/shared";
import type { ControlClient } from "@spcode/shared/control-client";
import type { SpcodeApi } from "../../preload/index";
import { subscribeControlEvents } from "./control";

function unsupported(name: string): never {
  throw new Error(`浏览器暂不支持原生能力：${name}`);
}

function selectFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = "none";
    document.body.append(input);
    input.addEventListener("change", () => {
      resolve([...(input.files ?? [])]);
      input.remove();
    });
    input.addEventListener("cancel", () => {
      resolve([]);
      input.remove();
    });
    input.click();
  });
}

function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * 浏览器端 SpcodeApi 适配器。核心会话命令仍由桌面现有主进程执行，
 * 控制面只做认证传输，避免在 Web 端复制注册表、权限和 Session 生命周期逻辑。
 */
export function createBrowserSpcodeApi(client: ControlClient): SpcodeApi {
  const invoke = <T = unknown>(method: string, ...args: unknown[]) => client.desktopInvoke<T>(method, args);
  const hostListeners = new Set<(event: HostEvent) => void>();
  subscribeControlEvents((event) => {
    if (event.type === "host.event") for (const listener of hostListeners) listener(event.event);
  });

  const overrides = {
    isDesktop: false,
    command: <T = unknown>(command: unknown) => invoke<T>("command", command),
    onEvent: (callback: (event: HostEvent) => void) => {
      hostListeners.add(callback);
      return () => hostListeners.delete(callback);
    },
    listSessions: () => invoke("listSessions"),
    removeSession: (id: string) => invoke<void>("removeSession", id),
    searchSessions: (query: string) => invoke("searchSessions", query),
    getSettings: () => invoke("getSettings"),
    setSettings: (patch: unknown) => invoke("setSettings", patch),
    getComposerDrafts: () => invoke("getComposerDrafts"),
    setComposerDrafts: (drafts: unknown) => invoke<void>("setComposerDrafts", drafts),
    runRetryList: () => invoke("runRetryList"),
    runRetrySchedule: (input: unknown) => invoke("runRetrySchedule", input),
    runRetryCancel: (id: string) => invoke<void>("runRetryCancel", id),
    usageSession: (id: string) => invoke("usageSession", id),
    usageSummary: (days?: number) => invoke("usageSummary", days),
    usageAggregate: (range: string) => invoke("usageAggregate", range),
    quotaQuery: (force?: boolean) => invoke("quotaQuery", force),
    sandboxStatus: () => invoke("sandboxStatus"),
    scheduleList: () => invoke("scheduleList"),
    scheduleCreate: (input: unknown) => invoke("scheduleCreate", input),
    scheduleUpdate: (id: string, patch: unknown) => invoke("scheduleUpdate", id, patch),
    scheduleDelete: (id: string) => invoke<void>("scheduleDelete", id),
    scheduleRunNow: (id: string) => invoke<string>("scheduleRunNow", id),
    replyPermission: (requestId: string, approved: boolean, scope?: unknown) => {
      void invoke("replyPermission", requestId, approved, scope).catch((error) => console.error(error));
    },
    replyQuestion: (requestId: string, answers: unknown) => {
      void invoke("replyQuestion", requestId, answers).catch((error) => console.error(error));
    },
    revokePermissions: (sessionId?: string) => invoke("revokePermissions", sessionId),
    sessionGitState: (id: string) => invoke("sessionGitState", id),
    sessionGitDiff: (id: string) => invoke("sessionGitDiff", id),
    sessionGitRevert: (id: string) => invoke("sessionGitRevert", id),
    readPlanFile: (path: string) => invoke<string>("readPlanFile", path),
    readWorkspaceFile: (path: string, sessionId: string) => invoke("readWorkspaceFile", path, sessionId),
    readWorkspaceImage: (path: string, sessionId: string, documentPath?: string) =>
      invoke("readWorkspaceImage", path, sessionId, documentPath),
    showWorkspaceFileMenu: async () => ({ type: "cancelled" as const }),
    pickDirectory: async () => window.prompt("请输入这台电脑上项目目录的绝对路径："),
    pickImages: async () => {
      const files = await selectFiles("image/png,image/jpeg,image/gif,image/webp,image/bmp", true);
      return Promise.all(
        files.slice(0, 20).map(async (file) => ({
          name: file.name,
          mimeType: file.type || "image/png",
          data: await base64(file),
        })),
      );
    },
    pickFiles: async (): Promise<PickedFile[]> => {
      const files = await selectFiles(
        "image/*,.txt,.md,.json,.yaml,.yml,.ts,.tsx,.js,.py,.java,.go,.rs,.sh,.sql",
        true,
      );
      return Promise.all(
        files.slice(0, 20).map(async (file): Promise<PickedFile> => {
          if (file.type.startsWith("image/")) {
            if (file.size > 10 * 1024 * 1024) {
              return { kind: "rejected", name: file.name, size: file.size, reason: "图片超过 10MB" };
            }
            return { kind: "image", name: file.name, mimeType: file.type, data: await base64(file) };
          }
          if (file.size > 200 * 1024) {
            return { kind: "rejected", name: file.name, size: file.size, reason: "文本超过 200KB" };
          }
          return { kind: "text", name: file.name, size: file.size, text: await file.text() };
        }),
      );
    },
    getWindowChrome: async () => ({ platform: "web", fullScreen: false }),
    onWindowChromeChanged: () => () => {},
    onWindowCloseRequested: () => () => {},
    windowCloseResolve: async () => {},
    windowModalOverlaySet: async () => {},
    updateGetState: async () => ({ status: "idle" as const }),
    onUpdateState: () => () => {},
    updateCheck: async () => false,
    updateDownload: async () => {},
    updateInstall: async () => {},
    updateIgnore: async () => {},
    getAppVersion: async () => "web",
    openWorkbench: async () => {},
  };

  return new Proxy(overrides, {
    get(target, property: string) {
      if (property in target) return target[property as keyof typeof target];
      return () => unsupported(property);
    },
  }) as unknown as SpcodeApi;
}
