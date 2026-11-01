/** Electron/Chromium 网络栈适配：BrowserWindow、session.fetch 与 electron-updater。 */

import { buildChromiumProxyRule, isNetworkProxyConfigured, type NetworkProxySettings } from "@spcode/shared/proxy";
import { app, session } from "electron";
import { configureNetworkProxy } from "../network-proxy.js";

/** 主进程 Node 与两个 Chromium session 同步生效；setProxy 完成后再放行后续请求。 */
export async function applyNetworkProxy(settings: NetworkProxySettings): Promise<void> {
  configureNetworkProxy(settings);
  const proxyRule = buildChromiumProxyRule(settings);
  const config = proxyRule ? { mode: "fixed_servers" as const, proxyRules: proxyRule } : { mode: "direct" as const };
  await Promise.all([
    session.defaultSession.setProxy(config),
    // electron-updater 不使用 defaultSession（见其 electronHttpExecutor）。
    session.fromPartition("electron-updater", { cache: false }).setProxy(config),
  ]);
}

/** Chromium 代理认证不拼进 proxyRules，避免密码进入网络配置与日志。 */
export function registerNetworkProxyAuthentication(getSettings: () => NetworkProxySettings): void {
  app.on("login", (event, _webContents, _details, authInfo, callback) => {
    const settings = getSettings();
    if (!authInfo.isProxy || !isNetworkProxyConfigured(settings)) return;
    const proxyUrl = buildChromiumProxyRule(settings);
    if (!proxyUrl) return;
    const proxy = new URL(proxyUrl);
    const normalizeHost = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, "");
    if (normalizeHost(authInfo.host) !== normalizeHost(proxy.hostname) || authInfo.port !== settings.port) return;
    event.preventDefault();
    callback(settings.username, settings.password);
  });
}
