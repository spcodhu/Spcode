/**
 * QR payload 解析（spcode-remote://pair?...，桌面设置页展示 / 手机扫码或粘贴）。
 * 格式（桌面 pairing.ts 生成）：
 *   spcode-remote://pair?v=1&hosts=<逗号分隔的 base url，整体 URL 编码>&desktop_pk=<base64,URL编码>&otp=<8位数字>
 */

import { isValidPublicKey } from "./crypto";

export interface QrPayload {
  version: number;
  /** 桌面 harness 的 base url 列表（http://ip:port），按优先级排序 */
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
  if (v !== "1") throw new Error(`不支持的协议版本：${v ?? "缺失"}`);

  const hostsRaw = params.get("hosts");
  if (!hostsRaw) throw new Error("配对码缺少 hosts 参数");
  // URLSearchParams 已整体解码一次；hosts 是逗号分隔的 base url 列表
  const hosts = hostsRaw
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (hosts.length === 0) throw new Error("hosts 为空");
  for (const h of hosts) {
    if (!/^https?:\/\//.test(h)) throw new Error(`非法的桌面地址：${h}`);
  }

  const desktopPk = params.get("desktop_pk");
  if (!isValidPublicKey(desktopPk)) throw new Error("配对码中的桌面公钥非法");

  const otp = params.get("otp");
  if (!otp || !/^\d{8}$/.test(otp)) throw new Error("配对码中的 OTP 非法（应为 8 位数字）");

  return { version: 1, hosts, desktopPk, otp };
}
