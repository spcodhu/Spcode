/**
 * Node 网络栈的统一代理适配器（main 与 agent-host 各自加载一份）。
 *
 * - global fetch / WebSocket / pi provider：Undici 全局 dispatcher；
 * - ws / axios / web-push 等 Node http.Agent 消费方：createNodeProxyAgent()；
 * - Bedrock 与命令子进程：HTTP(S)_PROXY / ALL_PROXY 环境变量。
 *
 * 不把凭据写日志；关闭代理时恢复本进程加载本模块前的环境变量和 dispatcher。
 */

import { EventEmitter } from "node:events";
import type { Agent } from "node:http";
import {
  buildNetworkProxyUrl,
  DEFAULT_NETWORK_PROXY_SETTINGS,
  isNetworkProxyConfigured,
  type NetworkProxySettings,
  sanitizeNetworkProxySettings,
} from "@spcode/shared/proxy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { type Dispatcher, getGlobalDispatcher, install, ProxyAgent, setGlobalDispatcher } from "undici";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;
const originalEnv = new Map<string, string | undefined>(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
const originalDispatcher = getGlobalDispatcher();
const originalFetch = globalThis.fetch;
let installedFetch: typeof fetch | undefined;
let current: NetworkProxySettings = { ...DEFAULT_NETWORK_PROXY_SETTINGS };
let ownedDispatcher: Dispatcher | null = null;
let environmentManaged = false;

const ignoreDispatcherError = () => {};

function withErrorListener<T extends Dispatcher>(dispatcher: T): T {
  // 与 pi 的 http-dispatcher 同口径：中断流时内部 Client 的 error 不应成为未捕获异常。
  if (dispatcher instanceof EventEmitter) EventEmitter.prototype.on.call(dispatcher, "error", ignoreDispatcherError);
  return dispatcher;
}

function installMatchingFetch(): void {
  const shouldInstall =
    installedFetch === undefined ? globalThis.fetch === originalFetch : globalThis.fetch === installedFetch;
  if (!shouldInstall) return;
  install();
  installedFetch = globalThis.fetch;
}

function syncProxyEnvironment(settings: NetworkProxySettings): void {
  const proxyUrl = buildNetworkProxyUrl(settings);
  if (!proxyUrl && !environmentManaged) return;
  for (const key of PROXY_ENV_KEYS) {
    const original = originalEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  if (proxyUrl) {
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.ALL_PROXY = proxyUrl;
    process.env.http_proxy = proxyUrl;
    process.env.https_proxy = proxyUrl;
    process.env.all_proxy = proxyUrl;
  }
  environmentManaged = !!proxyUrl;
}

/** 配置当前 Node 进程的所有后续 fetch / Undici WebSocket 请求。 */
export function configureNetworkProxy(input: NetworkProxySettings): void {
  current = sanitizeNetworkProxySettings(input);
  syncProxyEnvironment(current);

  const proxyUrl = buildNetworkProxyUrl(current);
  const previous = ownedDispatcher;
  const dispatcher = proxyUrl ? withErrorListener(new ProxyAgent(proxyUrl)) : originalDispatcher;
  ownedDispatcher = proxyUrl ? dispatcher : null;
  setGlobalDispatcher(dispatcher);
  // 与 pi 官方实现一致：fetch/WebSocket 与 dispatcher 必须来自同一份 Undici，
  // 避免 Node 内置 fetch 与 npm Undici 在压缩响应、全局 WebSocket 上的兼容问题。
  installMatchingFetch();

  // close 是优雅关闭：进行中的响应可继续读完，新请求已经切到新 dispatcher。
  if (previous && previous !== dispatcher) void previous.close().catch(() => {});
}

export function getNetworkProxySettings(): NetworkProxySettings {
  return { ...current };
}

/** 给 ws / axios / web-push 等不接受 Undici dispatcher 的库使用。 */
export function createNodeProxyAgent(settings: NetworkProxySettings = current): Agent | undefined {
  const proxyUrl = buildNetworkProxyUrl(settings);
  if (!proxyUrl) return undefined;
  return settings.protocol === "socks5"
    ? (new SocksProxyAgent(proxyUrl) as unknown as Agent)
    : (new HttpsProxyAgent(proxyUrl) as unknown as Agent);
}

/**
 * 会话创建后仍可能切换代理，所以 spawnHook 每次执行都重建这几个受管字段；
 * 关闭代理时恢复进程启动前的值，而不是把用户原有环境变量一并删掉。
 */
export function applyNetworkProxyEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of PROXY_ENV_KEYS) {
    delete next[key];
    const original = originalEnv.get(key);
    if (original !== undefined) next[key] = original;
  }
  const proxyUrl = buildNetworkProxyUrl(current);
  if (proxyUrl) {
    next.HTTP_PROXY = proxyUrl;
    next.HTTPS_PROXY = proxyUrl;
    next.ALL_PROXY = proxyUrl;
    next.http_proxy = proxyUrl;
    next.https_proxy = proxyUrl;
    next.all_proxy = proxyUrl;
  }
  return next;
}

/** sandbox-runtime 的上游代理仅支持 HTTP(S)；SOCKS5 由子进程自身 ALL_PROXY 处理。 */
export function sandboxParentProxy(): { http: string; https: string } | undefined {
  if (!isNetworkProxyConfigured(current) || current.protocol === "socks5") return undefined;
  const proxyUrl = buildNetworkProxyUrl(current);
  return proxyUrl ? { http: proxyUrl, https: proxyUrl } : undefined;
}
