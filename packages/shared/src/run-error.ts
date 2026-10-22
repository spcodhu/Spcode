/**
 * 运行错误分类（纯函数，主进程与渲染进程共用）。
 *
 * 背景：pi 引擎在额度/账单类错误上不重试（pi-ai 的 NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN），
 * 失败回合的 assistant 消息 content 为空、只带 stopReason="error" + errorMessage。
 * 旧实现完全没消费这两个字段 → 任务"凭空中断"、界面无任何提示。
 * 这里把上游错误归一成当前语言的处理建议，供错误卡/系统通知共用。
 *
 * 放在 shared 包并用子路径导出（与 advanced-search 同模式）：本包运行时以 TS 源码被直接加载，
 * index.ts 只允许 type-only 重导出，运行时代码走 "./run-error"。
 */

import { getLocale, i18n } from "./i18n/index.js";

export type RunErrorKind = "quota" | "auth" | "rateLimit" | "overflow" | "network" | "other";

export interface RunErrorInfo {
  kind: RunErrorKind;
  /** 一句话结论（错误卡标题 / 系统通知标题） */
  title: string;
  /** 处理建议（错误卡正文） */
  hint: string;
}

/** 上下文超长（先判，避免被下面的 exceed/overflow 规则误吞） */
const OVERFLOW = /context (?:length|window)|maximum context|too long for (?:the )?model|prompt is too long|overflow/i;
/** 额度/账单耗尽：pi 同样视为不可重试 */
const QUOTA =
  /insufficient_quota|quota exceeded|exceed(?:ed)? (?:your|the) quota|out of budget|available balance|billing|insufficient balance|insufficient credits?|GoUsageLimitError|FreeUsageLimitError|余额不足|额度不足|额度已用|欠费|\b402\b/i;
/** 鉴权失败 */
const AUTH =
  /unauthorized|invalid[ _-]?api[ _-]?key|authentication|no api key|invalid bearer|permission denied.*key|\b401\b/i;
/** 显式限流：pi 会自动重试，重试耗尽才落到这里 */
const RATE_LIMIT = /rate.?limit|too many requests|overloaded|high demand|\b429\b/i;
/** 传输层/网络层失败 */
const NETWORK =
  /fetch failed|enotfound|eai_again|econnreset|econnrefused|socket hang up|socket connection|network|timed? out|timeout|getaddrinfo|upstream connect/i;

/** 判定错误类别（导出供单测；空消息归 other） */
export function classifyRunErrorKind(message?: string | null): RunErrorKind {
  const text = (message ?? "").trim();
  if (!text) return "other";
  if (OVERFLOW.test(text)) return "overflow";
  if (QUOTA.test(text)) return "quota";
  if (AUTH.test(text)) return "auth";
  if (RATE_LIMIT.test(text)) return "rateLimit";
  if (NETWORK.test(text)) return "network";
  return "other";
}

export function classifyRunError(message?: string | null, locale: "zh-CN" | "en" = getLocale()): RunErrorInfo {
  const kind = classifyRunErrorKind(message);
  return {
    kind,
    title: i18n.t(`errors:run.${kind}.title`, { lng: locale }),
    hint: i18n.t(`errors:run.${kind}.hint`, { lng: locale }),
  };
}
