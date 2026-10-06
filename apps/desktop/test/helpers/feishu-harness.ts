/**
 * 飞书通道测试夹具：FakeFeishuApi（FeishuApi 窄接口的内存实现，不打真实网络）
 * + channel 依赖桩（bridge / scheduler / registry / settings）与绑定辅助。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  type HostCommand,
  type HostEvent,
  type ScheduleTask,
  type ScheduleTaskInput,
} from "@spcode/shared";
import {
  FeishuChannel,
  type FeishuApi,
  type FeishuCardAction,
  type FeishuChannelDeps,
  type FeishuInboundMessage,
} from "../../src/main/remote/channel/feishu.js";
import type { RegistryLike } from "../../src/main/session-helpers.js";
import type { SessionRegistryEntry } from "../../src/main/session-registry.js";

export class FakeFeishuApi implements FeishuApi {
  texts: { openId: string; text: string }[] = [];
  cards: { openId: string; card: Record<string, unknown>; messageId: string }[] = [];
  updates: { messageId: string; card: Record<string, unknown> }[] = [];
  started = 0;
  stopped = 0;
  private seq = 0;
  private msgCb: ((msg: FeishuInboundMessage) => void) | null = null;
  private actionCb: ((action: FeishuCardAction) => void) | null = null;

  async start(): Promise<void> {
    this.started += 1;
  }
  async stop(): Promise<void> {
    this.stopped += 1;
  }
  onMessage(cb: (msg: FeishuInboundMessage) => void): void {
    this.msgCb = cb;
  }
  onCardAction(cb: (action: FeishuCardAction) => void): void {
    this.actionCb = cb;
  }
  async sendText(openId: string, text: string): Promise<string> {
    this.texts.push({ openId, text });
    return `m${++this.seq}`;
  }
  async sendCard(openId: string, card: Record<string, unknown>): Promise<string> {
    const messageId = `m${++this.seq}`;
    this.cards.push({ openId, card, messageId });
    return messageId;
  }
  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    this.updates.push({ messageId, card });
  }

  emitMessage(msg: FeishuInboundMessage): void {
    this.msgCb?.(msg);
  }
  emitCardAction(action: FeishuCardAction): void {
    this.actionCb?.(action);
  }
}

/** handleInbound / handleCardAction 是 fire-and-forget：冲刷微任务队列等异步链落定 */
export async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

export function makeRegistry(entries: SessionRegistryEntry[] = []): RegistryLike & { entries: Map<string, SessionRegistryEntry> } {
  const map = new Map(entries.map((e) => [e.id, e]));
  return {
    entries: map,
    list: () => [...map.values()],
    get: (id) => map.get(id),
    upsert: (entry) => void map.set(entry.id, entry),
    patch: (id, patch) => {
      const cur = map.get(id);
      if (cur) map.set(id, { ...cur, ...patch, id, updatedAt: Date.now() });
    },
    remove: (id) => void map.delete(id),
  };
}

export function makeEntry(id: string, title: string, mode: "chat" | "project" = "chat"): SessionRegistryEntry {
  return {
    id,
    mode,
    cwd: mode === "project" ? "/tmp/proj" : "",
    title,
    model: null,
    thinkingLevel: "medium",
    sessionFile: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

export function makeScheduler(tasks: ScheduleTask[] = []) {
  const runNowCalls: string[] = [];
  return {
    runNowCalls,
    scheduler: {
      list: () => tasks,
      create: (input: ScheduleTaskInput) => ({ ...input, id: "t-new", createdAt: 1 }),
      update: () => null,
      remove: () => {},
      runNow: async (id: string) => {
        runNowCalls.push(id);
        return "sess-run-1";
      },
    },
  };
}

export const DEFAULT_TASKS: ScheduleTask[] = [
  {
    id: "t1",
    name: "晨报",
    prompt: "早报",
    target: { kind: "chat" },
    frequency: "daily",
    hour: 9,
    minute: 0,
    enabled: true,
    createdAt: 0,
  },
  {
    id: "t2",
    name: "晨间清理",
    prompt: "清理",
    target: { kind: "chat" },
    frequency: "weekly",
    hour: 8,
    minute: 30,
    weekday: 1,
    enabled: false,
    createdAt: 0,
  },
];

export interface ChannelHarness {
  api: FakeFeishuApi;
  channel: FeishuChannel;
  bridgeCalls: HostCommand[];
  permissionReplies: { requestId: string; approved: boolean; by?: "local" | "remote" }[];
  questionReplies: { requestId: string; answers: Record<string, string> }[];
  registry: ReturnType<typeof makeRegistry>;
  scheduler: ReturnType<typeof makeScheduler>;
  emit: (event: HostEvent) => void;
  baseDir: string;
  clock: { now: number };
}

export function makeChannel(opts: { sessions?: SessionRegistryEntry[]; baseDir?: string } = {}): ChannelHarness {
  const baseDir = opts.baseDir ?? mkdtempSync(join(tmpdir(), "spcode-feishu-test-"));
  const api = new FakeFeishuApi();
  const registry = makeRegistry(opts.sessions);
  const bridgeCalls: HostCommand[] = [];
  const permissionReplies: ChannelHarness["permissionReplies"] = [];
  const questionReplies: ChannelHarness["questionReplies"] = [];
  const listeners = new Set<(e: HostEvent) => void>();
  const clock = { now: 1_000_000 };
  const scheduler = makeScheduler([...DEFAULT_TASKS]);
  const deps: FeishuChannelDeps = {
    bridge: {
      async call(cmd: HostCommand & { id: string }) {
        bridgeCalls.push(cmd);
        if (cmd.type === "session.create") {
          return {
            sessionId: cmd.payload.sessionId,
            sessionFile: `/tmp/${cmd.payload.sessionId}.jsonl`,
            model: { provider: "anthropic", modelId: "claude" },
            thinkingLevel: "high",
          };
        }
        return { ok: true };
      },
      replyPermission: (requestId, approved, by) => permissionReplies.push({ requestId, approved, by }),
      replyQuestion: (requestId, answers) => questionReplies.push({ requestId, answers }),
      emitLocal: () => {},
      onEvent: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
    scheduler: scheduler.scheduler,
    registry,
    settings: { get: () => ({ ...DEFAULT_SETTINGS }) },
    api,
    baseDir,
    now: () => clock.now,
  };
  const channel = new FeishuChannel(deps);
  return {
    api,
    channel,
    bridgeCalls,
    permissionReplies,
    questionReplies,
    registry,
    scheduler,
    emit: (e) => {
      for (const l of listeners) l(e);
    },
    baseDir,
    clock,
  };
}

/** 启动通道并完成一个用户的绑定（返回其 openId） */
export async function startAndBind(h: ChannelHarness, openId = "ou_user1"): Promise<string> {
  await h.channel.start({ appId: "cli_test", appSecret: "secret" });
  const code = h.channel.pendingBindCode();
  h.api.emitMessage({ openId, text: `/bind ${code}`, chatType: "p2p" });
  await flush();
  return openId;
}

/** 卡片 JSON 的扁平文本（断言用） */
export function cardText(card: Record<string, unknown>): string {
  return JSON.stringify(card);
}
