/**
 * QR payload 解析（spcode-remote://pair?...，桌面设置页展示 / 手机扫码或粘贴）。
 * 格式（桌面 pairing.ts 生成，协议 v3 / QR v4）：
 *   spcode-remote://pair?v=4&hosts=<逗号分隔的 base url，整体 URL 编码>&desktop_pk=<base64,URL编码>&otp=<8位数字>
 *     [&relay_key=<自托管访问密钥>][&relay_grant=<exp>.<base64url mac>]
 */

import type { RelayDeviceGrant } from "@spcode/shared";
import { decodeGrantParam, isValidPublicKey } from "@spcode/shared/crypto";
import { MobileError } from "./i18n";
import { isRelayHost } from "./relay";

export interface QrPayload {
  version: number;
  /**
   * 桌面 harness 的地址列表，按优先级排序：
   * - 普通项：局域网直连 base url（http://ip:port）；
   * - `relay+wss://…` 前缀项：relay 通道（见 lib/relay.ts）。
   */
  hosts: string[];
  /** 桌面 X25519 公钥（base64） */
  desktopPk: string;
  /** 8 位数字一次性配对码 */
  otp: string;
  /** 自托管 relay 可选访问密钥；仅用于申请短时票据，不是 E2E 私钥。 */
  relayAccessKey?: string;
  /** 协议 v3：桌面签发的配对准入令牌（subject "pair"，随 OTP 过期）；relay 启用时必带 */
  relayGrant?: RelayDeviceGrant;
}

const SCHEME_PREFIX = "spcode-remote://pair";
const QR_VERSION = "4";

export function parseQrPayload(text: string): QrPayload {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SCHEME_PREFIX)) {
    throw new MobileError("qr.invalid");
  }
  const qIndex = trimmed.indexOf("?");
  if (qIndex < 0) throw new MobileError("qr.noParams");
  const params = new URLSearchParams(trimmed.slice(qIndex + 1));

  const v = params.get("v");
  if (v !== QR_VERSION) {
    if (v == null) throw new MobileError("qr.missingVersion");
    // 协议 v3 硬切换：旧桌面生成的 v1–v3 二维码一律要求先升级桌面
    if (/^[123]$/.test(v)) throw new MobileError("qr.oldVersion");
    throw new MobileError("qr.version", { version: v });
  }

  const hostsRaw = params.get("hosts");
  if (!hostsRaw) throw new MobileError("qr.noHosts");
  // URLSearchParams 已整体解码一次；hosts 是逗号分隔的 base url 列表
  const hosts = hostsRaw
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (hosts.length === 0) throw new MobileError("qr.emptyHosts");
  for (const h of hosts) {
    if (isRelayHost(h)) {
      if (!/^relay\+wss?:\/\//.test(h)) throw new MobileError("qr.relayHost", { host: h });
    } else if (!/^https?:\/\//.test(h)) {
      throw new MobileError("qr.desktopHost", { host: h });
    }
  }

  const desktopPk = params.get("desktop_pk");
  if (!isValidPublicKey(desktopPk)) throw new MobileError("qr.publicKey");

  const otp = params.get("otp");
  if (!otp || !/^\d{8}$/.test(otp)) throw new MobileError("qr.otp");
  const relayAccessKey = params.get("relay_key")?.trim() || undefined;
  const grantRaw = params.get("relay_grant")?.trim();
  const relayGrant = grantRaw ? decodeGrantParam(grantRaw) : null;
  if (grantRaw && !relayGrant) throw new MobileError("qr.relayGrant");

  return {
    version: Number(v),
    hosts,
    desktopPk,
    otp,
    ...(relayAccessKey ? { relayAccessKey } : {}),
    ...(relayGrant ? { relayGrant } : {}),
  };
}
