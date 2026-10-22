/**
 * 会话生命周期共享助手：从 index.ts 抽出，供 IPC 链路与远程控制链路复用
 * （远程 session.create / session.rename / session.remove 与定时任务
 * fireScheduledTask 需要同一套回填/清理逻辑）。
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { HostCommand, HostEvent } from "@spcode/shared";
import { i18n, isDefaultSessionTitle, localizeDefaultTitle } from "@spcode/shared/i18n";
import { resolveSpcodeHome } from "@spcode/shared/node";
import type { SessionRegistryEntry } from "./session-registry.js";

/** session.fork 命令的 payload 类型（从 HostCommand 提取，与协议保持同源） */
export type ForkPayload = Extract<HostCommand, { type: "session.fork" }>["payload"];

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
export function isDefaultTitle(title: string, cwd: string, titleKind?: "default" | "custom"): boolean {
  return isDefaultSessionTitle({ title, cwd, titleKind });
}

/** 会话创建/恢复/唤醒/分叉成功后回填 sessionFile 等到注册表（支撑下次恢复） */
export function backfillSessionFile(cmd: HostCommand, result: unknown, registry: RegistryLike): void {
  if (
    cmd.type !== "session.create" &&
    cmd.type !== "session.open" &&
    cmd.type !== "session.activate" &&
    cmd.type !== "session.fork"
  )
    return;
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
 * Fork 命令的注册表补全（主进程 IPC 层调用）：渲染层只传 sourceSessionId/newSessionId
 * 与可选项；源会话的 sessionFile/cwd/mode 与缺省继承的 model/thinkingLevel/planMode
 * 都在这里补齐（对照 Claude Code fork：未显式指定的维度继承源会话）。
 * 源会话不存在 → ok:false（调用方据此报错）。
 */
export function prepareForkCommand(
  registry: RegistryLike,
  payload: ForkPayload,
): { ok: true; payload: ForkPayload } | { ok: false; error: string } {
  const source = registry.get(payload.sourceSessionId);
  if (!source) return { ok: false, error: i18n.t("integration:session.sourceMissing") };
  return {
    ok: true,
    payload: {
      ...payload,
      sourceSessionFile: source.sessionFile ?? undefined,
      cwd: source.cwd,
      mode: source.mode,
      model: payload.model ?? source.model ?? undefined,
      thinkingLevel: payload.thinkingLevel ?? source.thinkingLevel,
      planMode: payload.planMode ?? source.planMode ?? false,
    },
  };
}

/**
 * Fork 成功后的注册表新条目：继承源会话的 mode/cwd，标题默认「<源标题> · 分叉」。
 * 不复制 planFile——计划文件按 sessionId 命名（~/.spcode/plans/<id>.md），互不相干。
 */
export function buildForkRegistryEntry(
  source: SessionRegistryEntry,
  payload: ForkPayload,
  now = Date.now(),
): SessionRegistryEntry {
  const title =
    normalizeSessionTitle(payload.title ?? "") ||
    normalizeSessionTitle(i18n.t("integration:session.forkTitle", { title: localizeDefaultTitle(source).title }));
  return {
    id: payload.newSessionId,
    mode: source.mode,
    cwd: source.cwd,
    title,
    titleKind: "custom",
    model: payload.model ?? source.model,
    thinkingLevel: payload.thinkingLevel ?? source.thinkingLevel,
    sessionFile: null,
    planMode: payload.planMode ?? source.planMode ?? false,
    planFile: null,
    forkedFrom: source.id,
    createdAt: now,
    updatedAt: now,
  };
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
  deps.registry.patch(sessionId, { title: clean, titleKind: "custom", updatedAt: Date.now() });
  deps.events?.emitLocal?.({ type: "session.renamed", sessionId, title: clean });
  return true;
}

/** 会话 id 白名单（评审 R3-C8：id 参与拼文件路径，防 `../../` 路径穿越删任意 .md） */
const SESSION_ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

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
  // 计划文件随会话一并清理（id 过白名单后才允许拼路径）
  if (SESSION_ID_SAFE.test(sessionId)) {
    rmSync(join(deps.plansDir ?? join(resolveSpcodeHome(), "plans"), `${sessionId}.md`), { force: true });
  }
  // 宿主里的活跃实例也一并释放
  await deps.bridge
    .call({ id: `dispose-${sessionId}`, type: "session.dispose", payload: { sessionId } })
    .catch(() => {});
  deps.events?.emitLocal?.({ type: "sessions.changed" });
}
