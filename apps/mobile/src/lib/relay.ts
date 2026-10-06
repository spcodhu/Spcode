/**
 * relay 通道工具（M2）：QR hosts 里 `relay+wss://…` 前缀项的解析与连接参数推导。
 *
 * 契约（packages/shared/src/remote.ts + apps/relay）：
 * - hosts 中以 `relay+` 开头的项为 relay 通道，去掉前缀后按
 *   `wss://<relay>/channel/<channelId>?role=device` 建连；
 * - channelId = SHA-256(桌面 X25519 公钥原始 32 字节) 的 hex 小写
 *   （与桌面端 transport/relay.ts 的 deriveChannelId 同式）；
 * - relay 是广播语义：帧外层 deviceId 的封装/过滤在 client.ts 处理。
 */

import { b64decode } from "./base64";
import { sha256Sync } from "./sha256";

export const RELAY_HOST_PREFIX = "relay+";

/** hosts 项是否 relay 通道（`relay+wss://…` / `relay+ws://…`） */
export function isRelayHost(host: string): boolean {
  return host.startsWith(RELAY_HOST_PREFIX);
}

/** channelId = SHA-256(桌面公钥原始 32 字节) 的 hex 小写（纯 JS 实现，非安全上下文可用） */
export function deriveChannelId(desktopPkB64: string): string {
  const digest = sha256Sync(b64decode(desktopPkB64));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** relay hosts 项 → 设备侧 ws url：`wss://<relay>/channel/<channelId>?role=device` */
export function relayWsUrl(host: string, desktopPkB64: string): string {
  const base = host.slice(RELAY_HOST_PREFIX.length).replace(/\/+$/, "");
  return `${base}/channel/${deriveChannelId(desktopPkB64)}?role=device`;
}

/**
 * 连接尝试顺序：LAN 直连优先，全部直连失败后才轮到 relay
 * （各自组内保持 QR 中的相对顺序；RemoteClient 按此列表轮转）。
 */
export function orderHosts(hosts: string[]): string[] {
  const lan = hosts.filter((h) => !isRelayHost(h));
  const relay = hosts.filter(isRelayHost);
  return [...lan, ...relay];
}
