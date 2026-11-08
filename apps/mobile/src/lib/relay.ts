/**
 * relay 通道工具（M2 / 协议 v3）：QR hosts 里 `relay+wss://…` 前缀项的解析与连接参数推导。
 *
 * 契约（packages/shared/src/remote.ts + spcod-relay）：
 * - hosts 中以 `relay+` 开头的项为 relay 通道，去掉前缀后按
 *   `wss://<relay>/channel/<channelId>?role=device[&device=<id>]&ticket=<t>` 建连；
 * - channelId = SHA-256(桌面 X25519 公钥原始 32 字节) 的 hex 小写
 *   （与桌面端 transport/relay.ts 的 deriveChannelId 同式）；
 * - 协议 v3：relay 不再接受匿名 device。每次建连前必须凭桌面签发的准入令牌
 *   （配对时来自 QR 的 relay_grant，之后来自加密 pair_ack / auth_ack 的 relayGrant）
 *   `POST /v1/tickets` 换取 30s 单次票据；自托管访问密钥叠加为 Bearer 门槛。
 * - relay 定向投递：帧外层 deviceId 的封装/过滤在 client.ts 处理。
 */

import type { RelayDeviceGrant, RelayInfo } from "@spcode/shared";
import { deriveChannelId, isValidPublicKey } from "@spcode/shared/crypto";
import { OFFICIAL_RELAY_URL } from "@spcode/shared/remote";
import { MobileError } from "./i18n";

export const RELAY_HOST_PREFIX = "relay+";
export const RELAY_INFO_PATH = "/v1/relay-info";
export const RELAY_TICKET_PATH = "/v1/tickets";

/** hosts 项是否 relay 通道（`relay+wss://…` / `relay+ws://…`） */
export function isRelayHost(host: string): boolean {
  return host.startsWith(RELAY_HOST_PREFIX);
}

/** relay channelId 推导：实现已下沉 @spcode/shared/crypto（双端同一份，评审 R3-C12） */
export { deriveChannelId, OFFICIAL_RELAY_URL };

/** relay hosts 项 → 设备侧 ws url：`wss://<relay>/channel/<channelId>?role=device[&device=<deviceId>]`
 *  （device 参数让 relay 离线队列按设备分槽补投；配对连接尚无 deviceId 不带） */
export function relayWsUrl(host: string, desktopPkB64: string, deviceId?: string): string {
  const base = host.slice(RELAY_HOST_PREFIX.length).replace(/\/+$/, "");
  const dev = deviceId ? `&device=${encodeURIComponent(deviceId)}` : "";
  return `${base}/channel/${deriveChannelId(desktopPkB64)}?role=device${dev}`;
}

function httpBaseOf(host: string): string {
  return host.slice(RELAY_HOST_PREFIX.length).replace(/^ws/i, "http").replace(/\/+$/, "");
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

/** 令牌是否仍可用（留 5 秒余量抵消时钟偏差） */
export function isGrantUsable(grant: RelayDeviceGrant | undefined, now = Date.now()): grant is RelayDeviceGrant {
  return !!grant && grant.exp - 5_000 > now;
}

/**
 * 凭桌面签发的准入令牌换取单次 device 票据，返回 `&ticket=…` 查询串。
 * 无令牌 → relayGrantMissing（协议 v3 不存在匿名路径）；401/403 → relayUnauthorized（令牌过期/被拒）。
 */
export async function relayTicketQuery(
  host: string,
  desktopPkB64: string,
  deviceId: string | undefined,
  grant: RelayDeviceGrant | undefined,
  accessKey?: string,
): Promise<string> {
  if (!grant) throw new MobileError("error.relayGrantMissing");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (accessKey) headers.authorization = `Bearer ${accessKey}`;
  const response = await fetch(`${httpBaseOf(host)}${RELAY_TICKET_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      channelId: deriveChannelId(desktopPkB64),
      role: "device",
      ...(deviceId ? { deviceId } : {}),
      hostPk: desktopPkB64,
      grant,
    }),
  });
  if (response.status === 401 || response.status === 403) throw new MobileError("error.relayUnauthorized");
  if (!response.ok) throw new MobileError("error.relayUnavailable");
  const issued = (await response.json()) as { ticket?: unknown };
  if (typeof issued.ticket !== "string" || !issued.ticket) throw new MobileError("error.relayUnavailable");
  return `&ticket=${encodeURIComponent(issued.ticket)}`;
}

/** 设置页测试 relay：拉 relay-info 确认是 v3 中继（手机没有该 relay 的令牌，不能真实取票）。 */
export async function probeRelay(input: { url: string }): Promise<RelayInfo> {
  const base = input.url.replace(/^ws/i, "http").replace(/\/+$/, "");
  const response = await fetch(`${base}${RELAY_INFO_PATH}`);
  if (!response.ok) throw new MobileError("error.relayUnavailable");
  const info = (await response.json()) as Partial<RelayInfo>;
  if (info.version !== 3 || !isValidPublicKey(info.relayPk)) {
    throw new MobileError("error.relayUnavailable");
  }
  return { version: info.version, relayPk: info.relayPk };
}
