/**
 * 会话生命周期共享助手：从 index.ts 抽出，供 IPC 链路与远程控制链路复用
 * （远程 session.create / session.rename / session.remove 与定时任务
 * fireScheduledTask 需要同一套回填/清理逻辑）。
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { baseName, type HostCommand, type HostEvent } from "@spcode/shared";
import { resolveSpcodeHome } from "@spcode/shared/node";
import type { SessionRegistryEntry } from "./session-registry.js";

/** 注册表最小结构接口（handlers 单测可用纯 mock 实现） */
export interface RegistryLike {
  list(): SessionRegistryEntry[];
  get(id: string): SessionRegistryEntry | undefined;
  upsert(entry: SessionRegistryEntry): void;
  patch(id: string, patch: Partial<SessionRegistryEntry>): void;
  remove(id: string): void;
}

/** 生命周期助手需要的事件出口（AgentBridge.emitLocal 的结构子集） */
export interface LocalEventEmitter {
  emitLocal?(event: HostEvent): void;
}

/** 生命周期助手需要的宿主调用面（dispose 活跃会话实例） */
export interface SessionDisposeBridge {
  call(cmd: HostCommand & { id: string }): Promise<unknown>;
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

/** 标题入注册表前的归一化：去首尾空白、限长 100（与 PairHelloInner 设备名同口径） */
export function normalizeSessionTitle(title: string): string {
  return title.trim().slice(0, 100);
}

/**
 * 重命名会话：写注册表并广播 session.renamed（渲染进程与远程端都经该事件同步标题）。
 * 返回 false = 会话不存在或标题为空（调用方据此报错）。
 */
export function renameSession(
  deps: { registry: RegistryLike; events?: LocalEventEmitter },
  sessionId: string,
  title: string,
): boolean {
  const clean = normalizeSessionTitle(title);
  if (!clean) return false;
  if (!deps.registry.get(sessionId)) return false;
  deps.registry.patch(sessionId, { title: clean, updatedAt: Date.now() });
  deps.events?.emitLocal?.({ type: "session.renamed", sessionId, title: clean });
  return true;
}

/**
 * 删除会话：注册表移除 + 计划文件（~/.spcode/plans/<id>.md）清理 + 宿主活跃实例释放，
 * 最后广播 sessions.changed（渲染进程刷新列表，远程端同步各设备）。
 * 幂等：会话不存在时仍执行清理（计划文件/宿主实例可能是孤儿）。
 */
export async function removeSession(
  deps: { registry: RegistryLike; bridge: SessionDisposeBridge; events?: LocalEventEmitter; plansDir?: string },
  sessionId: string,
): Promise<void> {
  deps.registry.remove(sessionId);
  // 计划文件随会话一并清理
  rmSync(join(deps.plansDir ?? join(resolveSpcodeHome(), "plans"), `${sessionId}.md`), { force: true });
  // 宿主里的活跃实例也一并释放
  await deps.bridge
    .call({ id: `dispose-${sessionId}`, type: "session.dispose", payload: { sessionId } })
    .catch(() => {});
  deps.events?.emitLocal?.({ type: "sessions.changed" });
}
