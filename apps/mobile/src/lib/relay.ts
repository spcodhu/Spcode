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

import { deriveChannelId } from "@spcode/shared/crypto";
import { OFFICIAL_RELAY_URL } from "@spcode/shared/remote";
import { MobileError } from "./i18n";

export const RELAY_HOST_PREFIX = "relay+";

/** hosts 项是否 relay 通道（`relay+wss://…` / `relay+ws://…`） */
export function isRelayHost(host: string): boolean {
  return host.startsWith(RELAY_HOST_PREFIX);
}

/** relay channelId 推导：实现已下沉 @spcode/shared/crypto（双端同一份，评审 R3-C12） */
export { deriveChannelId, OFFICIAL_RELAY_URL };

/** relay hosts 项 → 设备侧 ws url：`wss://<relay>/channel/<channelId>?role=device&device=<deviceId>`
 *  （device 参数让 relay 离线队列按设备分槽补投——评审 R3-C9；缺省兼容旧 relay，收 "*" 槽） */
export function relayWsUrl(host: string, desktopPkB64: string, deviceId?: string): string {
  const base = host.slice(RELAY_HOST_PREFIX.length).replace(/\/+$/, "");
  const dev = deviceId ? `&device=${encodeURIComponent(deviceId)}` : "";
  return `${base}/channel/${deriveChannelId(desktopPkB64)}?role=device${dev}`;
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

/** 有访问密钥时先取单次 ticket；无密钥保持官方匿名/旧 relay 兼容。 */
export async function relayTicketQuery(
  host: string,
  desktopPkB64: string,
  role: "host" | "device",
  deviceId?: string,
  accessKey?: string,
): Promise<string> {
  if (!accessKey) return "";
  const base = host
    .slice(RELAY_HOST_PREFIX.length)
    .replace(/^ws/i, "http")
    .replace(/\/+$/, "");
  const response = await fetch(`${base}/v1/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessKey}` },
    body: JSON.stringify({ channelId: deriveChannelId(desktopPkB64), role, ...(deviceId ? { deviceId } : {}) }),
  });
  if (response.status === 401 || response.status === 403) throw new MobileError("error.relayUnauthorized");
  if (!response.ok) throw new MobileError("error.relayUnavailable");
  const grant = (await response.json()) as { ticket?: unknown };
  if (typeof grant.ticket !== "string" || !grant.ticket) throw new MobileError("error.relayUnavailable");
  return `&ticket=${encodeURIComponent(grant.ticket)}`;
}

/** 设置页测试 relay：无密钥查健康端点，有密钥真实签发票据，不建立控制连接。 */
export async function probeRelay(input: {
  url: string;
  desktopPk: string;
  accessKey?: string | null;
  deviceId?: string;
}): Promise<void> {
  const base = input.url.replace(/^ws/i, "http").replace(/\/+$/, "");
  if (input.accessKey) {
    await relayTicketQuery(`relay+${input.url}`, input.desktopPk, "device", input.deviceId, input.accessKey);
    return;
  }
  const response = await fetch(`${base}/health`);
  if (!response.ok) throw new MobileError("error.relayUnavailable");
}
