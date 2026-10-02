/**
 * 会话生命周期共享助手：从 index.ts 抽出，供 IPC 链路与远程控制链路复用
 * （远程 session.create 与定时任务 fireScheduledTask 需要同一套回填逻辑）。
 */

import { baseName, type HostCommand } from "@spcode/shared";
import type { SessionRegistryEntry } from "./session-registry.js";

/** 注册表最小结构接口（handlers 单测可用纯 mock 实现） */
export interface RegistryLike {
  list(): SessionRegistryEntry[];
  get(id: string): SessionRegistryEntry | undefined;
  upsert(entry: SessionRegistryEntry): void;
  patch(id: string, patch: Partial<SessionRegistryEntry>): void;
}

/** 判断标题是否仍是出厂默认（「新聊天」/「新项目」/目录名），是则允许用首条用户消息兜底 */
export function isDefaultTitle(title: string, cwd: string): boolean {
  return title === "新聊天" || title === "新项目" || title === baseName(cwd);
}

/** 会话创建/恢复成功后回填 sessionFile 等到注册表（支撑下次恢复） */
export function backfillSessionFile(cmd: HostCommand, result: unknown, registry: RegistryLike): void {
  if (cmd.type !== "session.create" && cmd.type !== "session.open") return;
  const data = result as
    | {
        sessionId?: string;
        sessionFile?: string | null;
        model?: { provider: string; modelId: string } | null;
        thinkingLevel?: string;
      }
    | undefined;
  if (!data?.sessionId) return;
  const entry = registry.get(data.sessionId);
  if (!entry) return;
  registry.patch(data.sessionId, {
    sessionFile: data.sessionFile ?? entry.sessionFile,
    model: data.model ?? entry.model,
    thinkingLevel: data.thinkingLevel ?? entry.thinkingLevel,
  });
}
