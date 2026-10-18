/**
 * QR payload 解析（spcode-remote://pair?...，桌面设置页展示 / 手机扫码或粘贴）。
 * 格式（桌面 pairing.ts 生成，协议 v2）：
 *   spcode-remote://pair?v=2&hosts=<逗号分隔的 base url，整体 URL 编码>&desktop_pk=<base64,URL编码>&otp=<8位数字>
 */

import { isValidPublicKey } from "./crypto";
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
    throw new Error("不是有效的配对码（应以 spcode-remote://pair 开头）");
  }
  const qIndex = trimmed.indexOf("?");
  if (qIndex < 0) throw new Error("配对码缺少参数");
  const params = new URLSearchParams(trimmed.slice(qIndex + 1));

  const v = params.get("v");
  if (v !== "2") {
    throw new Error(
      v === "1" ? "配对码版本过旧：桌面端已升级配对协议（v2），请在桌面设置页重新生成配对码" : `不支持的协议版本：${v ?? "缺失"}`,
    );
  }

  const hostsRaw = params.get("hosts");
  if (!hostsRaw) throw new Error("配对码缺少 hosts 参数");
  // URLSearchParams 已整体解码一次；hosts 是逗号分隔的 base url 列表
  const hosts = hostsRaw
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (hosts.length === 0) throw new Error("hosts 为空");
  for (const h of hosts) {
    if (isRelayHost(h)) {
      if (!/^relay\+wss?:\/\//.test(h)) throw new Error(`非法的 relay 地址：${h}`);
    } else if (!/^https?:\/\//.test(h)) {
      throw new Error(`非法的桌面地址：${h}`);
    }
  }

  const desktopPk = params.get("desktop_pk");
  if (!isValidPublicKey(desktopPk)) throw new Error("配对码中的桌面公钥非法");

  const otp = params.get("otp");
  if (!otp || !/^\d{8}$/.test(otp)) throw new Error("配对码中的 OTP 非法（应为 8 位数字）");

  return { version: 2, hosts, desktopPk, otp };
}
