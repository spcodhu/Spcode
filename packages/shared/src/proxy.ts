/** 桌面端统一出站代理配置（纯类型/纯函数，主进程、agent-host 与渲染层共用）。 */

export type NetworkProxyProtocol = "http" | "https" | "socks5";

export interface NetworkProxySettings {
  /** false = 不注入应用代理，恢复进程启动前的网络环境 */
  enabled: boolean;
  protocol: NetworkProxyProtocol;
  /** 仅主机名/IP，不含协议、路径或 userinfo */
  host: string;
  port: number;
  username: string;
  password: string;
}

export const DEFAULT_NETWORK_PROXY_SETTINGS: NetworkProxySettings = {
  enabled: false,
  protocol: "http",
  host: "",
  port: 8080,
  username: "",
  password: "",
};

export function sanitizeNetworkProxySettings(input: unknown): NetworkProxySettings {
  const src =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Partial<Record<keyof NetworkProxySettings, unknown>>)
      : {};
  const protocol = src.protocol === "https" || src.protocol === "socks5" ? src.protocol : "http";
  const port =
    typeof src.port === "number" && Number.isSafeInteger(src.port) && src.port >= 1 && src.port <= 65535
      ? src.port
      : DEFAULT_NETWORK_PROXY_SETTINGS.port;
  return {
    enabled: typeof src.enabled === "boolean" ? src.enabled : DEFAULT_NETWORK_PROXY_SETTINGS.enabled,
    protocol,
    host: typeof src.host === "string" ? src.host.trim() : "",
    port,
    username: typeof src.username === "string" ? src.username : "",
    password: typeof src.password === "string" ? src.password : "",
  };
}

/** host 可安全拼进 URL；支持 DNS、IPv4、带/不带方括号的 IPv6。 */
export function isValidNetworkProxyHost(host: string): boolean {
  const value = host.trim();
  if (!value || value.length > 512 || /[\s/@?#]/.test(value) || value.includes("://")) return false;
  if (value.includes("[") || value.includes("]")) {
    if (!/^\[[0-9a-f:.]+\]$/i.test(value)) return false;
  } else if (value.includes(":") && !/^[0-9a-f:.]+$/i.test(value)) {
    return false;
  }
  try {
    const hostname = value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
    new URL(`http://${hostname}`);
    return true;
  } catch {
    return false;
  }
}

export function isNetworkProxyConfigured(settings: NetworkProxySettings): boolean {
  return (
    settings.enabled &&
    isValidNetworkProxyHost(settings.host) &&
    Number.isSafeInteger(settings.port) &&
    settings.port >= 1 &&
    settings.port <= 65535
  );
}

function hostForUrl(host: string): string {
  const value = host.trim();
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

/**
 * 构造代理 URL。账号密码只在运行时注入，调用方不得记录返回值；
 * Chromium setProxy 使用不含凭据的 proxyRule，认证由 app.login 单独处理。
 */
export function buildNetworkProxyUrl(settings: NetworkProxySettings, includeCredentials = true): string | null {
  if (!isNetworkProxyConfigured(settings)) return null;
  const url = new URL(`${settings.protocol}://${hostForUrl(settings.host)}:${settings.port}`);
  if (includeCredentials && settings.username) {
    url.username = settings.username;
    url.password = settings.password;
  }
  return url.toString();
}

/** Electron proxyRules 的单条 fixed-server 规则（不带账号密码）。 */
export function buildChromiumProxyRule(settings: NetworkProxySettings): string | null {
  if (!isNetworkProxyConfigured(settings)) return null;
  return `${settings.protocol}://${hostForUrl(settings.host)}:${settings.port}`;
}

/** 配置指纹仅用于进程内重建连接；不得写日志或回传远程端。 */
export function networkProxyFingerprint(settings: NetworkProxySettings): string {
  return JSON.stringify(sanitizeNetworkProxySettings(settings));
}
