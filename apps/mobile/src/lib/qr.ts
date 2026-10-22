/**
 * QR payload 解析（spcode-remote://pair?...，桌面设置页展示 / 手机扫码或粘贴）。
 * 格式（桌面 pairing.ts 生成，协议 v2）：
 *   spcode-remote://pair?v=2&hosts=<逗号分隔的 base url，整体 URL 编码>&desktop_pk=<base64,URL编码>&otp=<8位数字>
 */

import { isValidPublicKey } from "@spcode/shared/crypto";
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
}

const SCHEME_PREFIX = "spcode-remote://pair";

export function parseQrPayload(text: string): QrPayload {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SCHEME_PREFIX)) {
    throw new MobileError("qr.invalid");
  }
  const qIndex = trimmed.indexOf("?");
  if (qIndex < 0) throw new MobileError("qr.noParams");
  const params = new URLSearchParams(trimmed.slice(qIndex + 1));

  const v = params.get("v");
  if (v !== "2") {
    if (v === "1") throw new MobileError("qr.oldVersion");
    if (v == null) throw new MobileError("qr.missingVersion");
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

  return { version: 2, hosts, desktopPk, otp };
}
