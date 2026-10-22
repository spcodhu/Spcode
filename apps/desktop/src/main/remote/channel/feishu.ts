/**
 * 飞书机器人通道（设计文档 4.8 / M4）：与 PWA 并列的可选通道，默认关闭。
 *
 * 定位与边界：
 * - 消息明文过飞书服务器，不走 E2E；复用与 WS 路径同一份 handleRemoteCommand 控制面，
 *   飞书只是一个新的「连接来源」（Channel 适配器，不是 Transport 的 PeerConnection 模型：
 *   自己维护事件订阅与出站长连接，直接调 handlers 的命令分发函数）。
 * - 鉴权 = 授权用户白名单（飞书 open_id），持久化在 ~/.spcode/remote/feishu.json
 *   （原子写 + 0600；只记 appId 引用与 open_id 列表，不重复存储 appSecret）。
 *   首条消息绑定流程：设置页展示 6 位验证码（5 分钟有效、单次），
 *   用户在飞书给机器人发 /bind <code> 成功后记入白名单；非白名单消息一律忽略
 *   （每个 open_id 每进程回一次「未授权」提示后静默）。
 *
 * 出站映射（RemoteEvent → 飞书消息）：
 * - permission.request → 交互卡片（工具名 + 参数摘要截断 + risk 徽章；
 *   danger 级红色头 + 按钮文案「确认允许危险操作」+ 完整参数）；
 *   任一端裁决后（permission.resolved）用 message_id patch 更新原卡片为「已批准/已拒绝（来源）」。
 * - question.request → 单题单选带选项时渲染选项按钮卡片；其余形态（多题/多选/自由文本）
 *   降级为文本提问并引导到桌面端回答（按钮 value 无法表达，如实说明）。
 * - session.output → 不滚动更新卡片：飞书卡片更新有限频，token 级刷卡片必然触发限流。
 *   采用 M4 建议的简单方案——每会话在内存里维护输出尾部缓冲，会话 running→idle 时
 *   发一条「完成摘要 + 最近输出尾部」文本消息（发给会话归属用户，未知归属则不推）。
 * - schedule.fired → 文本通知（广播全体白名单用户）。
 * - sessions.changed → 不主动推，等 /sessions 查询。
 *
 * SDK 隔离：真实飞书依赖封装在窄接口 FeishuApi 后面（LarkFeishuApi 实现，
 * @larksuiteoapi/node-sdk 的 WebSocket 长连接模式，出站连接无需公网回调）；
 * 单测用 fake FeishuApi，不打真实网络。
 */

import { randomInt } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  PermissionRequest,
  QuestionRequest,
  RemoteEvent,
  RemoteFeishuAllowedUser,
  RemoteFeishuState,
  RemoteFeishuStatus,
  SessionMeta,
} from "@spcode/shared";
import { validateQuestionAnswers } from "@spcode/shared";
import { getLocale, renderMessage } from "@spcode/shared/i18n";
import { readJsonFile, resolveSpcodeHome, writeJsonFileAtomic } from "@spcode/shared/node";
import { RemoteEventAggregator } from "../aggregator.js";
import { handleRemoteCommand, type RemoteHandlerDeps } from "../handlers.js";
import type { BridgeEventSource } from "../index.js";

// ---------------------------------------------------------------------------
// FeishuApi 窄接口（真实实现 = LarkFeishuApi；单测注入 fake）
// ---------------------------------------------------------------------------

/** 飞书入站文本消息（im.message.receive_v1 的归一化形态） */
export interface FeishuInboundMessage {
  /** 发送者 open_id */
  openId: string;
  /** 纯文本内容（非 text 类型消息不入此通道） */
  text: string;
  /** chat_type："p2p" | "group"；缺省按私聊处理 */
  chatType?: string;
}

/** 卡片按钮回调（card.action.trigger 的归一化形态） */
export interface FeishuCardAction {
  /** 操作者 open_id */
  operatorOpenId: string;
  /** 按钮 value（发卡片时填入的 JSON） */
  value: Record<string, unknown>;
  /** 原卡片消息 id（更新卡片用；缺省则无法更新原卡片） */
  messageId?: string;
}

/** 飞书通道状态查询（getStatus 用；connected 时才能收发消息） */
export interface FeishuApi {
  /** 建立出站长连接；resolve 即就绪，reject 表示建连失败 */
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(cb: (msg: FeishuInboundMessage) => void): void;
  onCardAction(cb: (action: FeishuCardAction) => void): void;
  /** 给指定用户私聊发文本，返回 message_id */
  sendText(openId: string, text: string): Promise<string>;
  /** 给指定用户私聊发交互卡片，返回 message_id */
  sendCard(openId: string, card: Record<string, unknown>): Promise<string>;
  /** 更新已发出的卡片（message.patch） */
  updateCard(messageId: string, card: Record<string, unknown>): Promise<void>;
}

export interface FeishuChannelDeps extends RemoteHandlerDeps {
  bridge: RemoteHandlerDeps["bridge"] & BridgeEventSource;
  /** 测试注入；缺省用 appId/appSecret 创建 LarkFeishuApi */
  api?: FeishuApi;
  /** 测试注入；缺省 ~/.spcode（feishu.json 存 <baseDir>/remote/ 下） */
  baseDir?: string;
  /** 测试注入时钟 */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const BIND_CODE_TTL_MS = 5 * 60_000;
/** 输出尾部缓冲上限（字符）：完成摘要只带最近输出，避免撑爆飞书消息体 */
const OUTPUT_TAIL_MAX = 3000;
/** 卡片参数摘要截断长度；danger 级完整展示（设计文档：danger 必须显示完整命令） */
const ARGS_SUMMARY_MAX = 800;
const ARGS_FULL_MAX = 4000;

// Resolve at send/patch time, never at module initialization.
const t = (key: string, params?: Record<string, string | number>): string =>
  renderMessage({ key: `feishu:${key}`, params });

// ---------------------------------------------------------------------------
// 白名单持久化（~/.spcode/remote/feishu.json，原子写 + 0600）
// ---------------------------------------------------------------------------

interface FeishuStoreData {
  /** appId 引用（open_id 按应用隔离，换 app 后旧白名单不再生效） */
  appId: string;
  allowlist: RemoteFeishuAllowedUser[];
}

function validateStore(data: unknown): FeishuStoreData | null {
  if (!data || typeof data !== "object") return null;
  const r = data as Record<string, unknown>;
  if (typeof r.appId !== "string" || !Array.isArray(r.allowlist)) return null;
  for (const u of r.allowlist) {
    if (!u || typeof u !== "object") return null;
    const ur = u as Record<string, unknown>;
    if (typeof ur.openId !== "string" || typeof ur.boundAt !== "number") return null;
  }
  return data as FeishuStoreData;
}

// ---------------------------------------------------------------------------
// 卡片构造
// ---------------------------------------------------------------------------

function mdCard(
  title: string,
  template: string,
  md: string,
  actions?: Record<string, unknown>[],
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [{ tag: "div", text: { tag: "lark_md", content: md } }];
  if (actions && actions.length > 0) elements.push({ tag: "action", actions });
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: title }, template },
    elements,
  };
}

function button(text: string, type: string, value: Record<string, unknown>): Record<string, unknown> {
  return { tag: "button", text: { tag: "plain_text", content: text }, type, value };
}

const RISK_TEMPLATE: Record<string, string> = { readonly: "blue", write: "orange", outward: "orange", danger: "red" };

function permissionCard(request: PermissionRequest): Record<string, unknown> {
  const danger = request.risk === "danger";
  // 逃生舱请求（沙盒外执行）等同高危呈现：红头 + 完整参数 + 警示文案
  const bypass = request.bypass === true;
  const severe = danger || bypass;
  const argsText = truncateArgs(request.args, severe ? ARGS_FULL_MAX : ARGS_SUMMARY_MAX);
  const bypassNote = bypass ? `\n**${t("permission.bypassWarning")}**\n` : "\n";
  const md = `**${t("permission.tool")}**: \`${request.toolName}\`\n**${t("permission.risk")}**: ${t(`risk.${request.risk}`)}${bypassNote}**${t("permission.args")}**:\n\`\`\`\n${argsText}\n\`\`\``;
  return mdCard(
    t("permission.title", { tool: request.toolName }),
    severe ? "red" : (RISK_TEMPLATE[request.risk] ?? "blue"),
    md,
    [
      button(
        t(danger ? "permission.allowDanger" : bypass ? "permission.allowBypass" : "permission.approve"),
        severe ? "danger" : "primary",
        {
          action: "permission",
          requestId: request.requestId,
          approved: true,
        },
      ),
      button(t("permission.deny"), "default", { action: "permission", requestId: request.requestId, approved: false }),
    ],
  );
}

function resolvedCard(request: PermissionRequest, approved: boolean, by: "local" | "remote"): Record<string, unknown> {
  const from = t(by === "local" ? "permission.local" : "permission.remote");
  const mark = t(approved ? "permission.approved" : "permission.denied", { from });
  return mdCard(
    t("permission.title", { tool: request.toolName }),
    approved ? "green" : "grey",
    `${mark}\n\n**${t("permission.tool")}**: \`${request.toolName}\``,
  );
}

function questionCard(request: QuestionRequest): Record<string, unknown> | null {
  // 仅「单题 + 单选 + 有选项」能映射成按钮卡片；其余形态返回 null 走文本降级
  if (request.questions.length !== 1) return null;
  const q = request.questions[0]!;
  if (q.multiSelect || !q.options || q.options.length === 0) return null;
  const actions = q.options.map((opt) =>
    button(opt.presentation?.label ? renderMessage(opt.presentation.label) : opt.label, "default", {
      action: "question",
      requestId: request.requestId,
      answers: { "0": { kind: "options", values: [opt.value] } },
    }),
  );
  const title = q.presentation?.question ? renderMessage(q.presentation.question) : q.question;
  return mdCard(t("question.title"), "wathet", `**${title}**`, actions);
}

function closedQuestionCard(): Record<string, unknown> {
  return mdCard(t("question.title"), "grey", t("question.closed"));
}

type SentCard = { openId: string; messageId: string; updates: Promise<void> };
type PendingPermission = {
  request: PermissionRequest;
  sent: SentCard[];
  submitted: boolean;
  resolved?: { approved: boolean; by: "local" | "remote" };
};
type PendingQuestion = { request: QuestionRequest; sent: SentCard[]; submitted: boolean; resolved: boolean };

function truncateArgs(args: unknown, max: number): string {
  let text: string;
  try {
    text = typeof args === "string" ? args : (JSON.stringify(args, null, 2) ?? "");
  } catch {
    text = String(args);
  }
  return text.length > max ? `${text.slice(0, max)}…${t("truncated")}` : text;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function describeFeishuSchedule(task: import("@spcode/shared").ScheduleTask): string {
  const time = `${String(task.hour).padStart(2, "0")}:${String(task.minute).padStart(2, "0")}`;
  switch (task.frequency) {
    case "once":
      return task.runAt
        ? t("schedule.onceAt", {
            time: new Date(task.runAt).toLocaleString(getLocale(), {
              month: "numeric",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }),
          })
        : t("schedule.once");
    case "hourly":
      return t("schedule.hourly", { minute: task.minute });
    case "daily":
    case "weekday":
      return t(`schedule.${task.frequency}`, { time });
    case "weekly": {
      // 2024-01-07 is Sunday. Preserve the shared scheduler's Monday default.
      const weekday = new Date(2024, 0, 7 + (task.weekday ?? 1)).toLocaleDateString(getLocale(), { weekday: "long" });
      return t("schedule.weekly", { weekday, time });
    }
  }
}

// ---------------------------------------------------------------------------
// FeishuChannel
// ---------------------------------------------------------------------------

export class FeishuChannel {
  private readonly deps: FeishuChannelDeps;
  private readonly storeFile: string;
  private readonly now: () => number;
  private readonly aggregator: RemoteEventAggregator;
  private api: FeishuApi | null = null;
  private state: RemoteFeishuState = "disabled";
  private unsubscribeBridge: (() => void) | null = null;

  /** 白名单（open_id → 记录）；loadStore 后内存为唯一事实源，变更即落盘 */
  private allowlist = new Map<string, RemoteFeishuAllowedUser>();
  private cfgAppId = "";
  /** 绑定验证码（6 位，5 分钟有效，单次）；pendingBindCode() 惰性生成 */
  private bindCode: { code: string; expiresAt: number } | null = null;
  /** 已提示过「未授权」的 open_id（每进程一次，之后静默忽略） */
  private readonly notifiedUnauthorized = new Set<string>();

  /** 每用户当前会话上下文（open_id → sessionId），进程内存即可 */
  private readonly contexts = new Map<string, string>();
  /** 会话归属（sessionId → 创建/绑定它的 open_id）：完成摘要与输出推送的目标 */
  private readonly sessionOwners = new Map<string, string>();
  /** 每用户最近一次 /sessions 的编号 → sessionId 映射（/use <编号> 用） */
  private readonly lastList = new Map<string, string[]>();
  /** 会话状态快照（session.status 事件维护，/sessions 徽章用） */
  private readonly sessionStatus = new Map<string, "running" | "idle" | "waiting_permission">();
  /** 输出尾部缓冲（sessionId → 最近输出文本，running→idle 时随摘要发出） */
  private readonly outputTails = new Map<string, string>();
  /** 进行中的权限卡片（requestId → 已发出的卡片位置 + 原始请求，resolved 时更新原卡片） */
  private readonly permissionCards = new Map<string, PendingPermission>();
  private readonly questionCards = new Map<string, PendingQuestion>();
  /** /bind 连续失败计数与锁定（评审 R3-C9：6 位验证码 5 分钟窗口需要防在线爆破） */
  private bindFailures = 0;
  private bindLockedUntil = 0;

  constructor(deps: FeishuChannelDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.storeFile = join(deps.baseDir ?? resolveSpcodeHome(), "remote", "feishu.json");
    this.aggregator = new RemoteEventAggregator({ emit: (event) => this.handleRemoteEvent(event) });
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /** 建立长连接 + 订阅 bridge 事件；建连失败置 error 态（不抛出，由 RemoteStatus 透出） */
  async start(cfg: { appId: string; appSecret: string }): Promise<void> {
    if (this.state === "connecting" || this.state === "connected") return;
    this.cfgAppId = cfg.appId;
    this.loadStore();
    this.state = "connecting";
    this.api = this.deps.api ?? new LarkFeishuApi(cfg);
    this.api.onMessage((msg) => void this.handleInbound(msg));
    this.api.onCardAction((action) => void this.handleCardAction(action));
    try {
      await this.api.start();
    } catch (err) {
      this.state = "error";
      console.warn("[remote/feishu] 长连接建立失败", err);
      return;
    }
    this.state = "connected";
    // 通道自己的事件订阅（独立于 RemoteServer 的 WS 聚合器，feishu.enabled 不要求 remote.enabled）
    this.unsubscribeBridge = this.deps.bridge.onEvent((event) => this.aggregator.handle(event));
  }

  async stop(): Promise<void> {
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = null;
    this.aggregator.dispose();
    const api = this.api;
    this.api = null;
    this.state = "disabled";
    this.bindCode = null;
    this.permissionCards.clear();
    this.questionCards.clear();
    await api?.stop();
  }

  /** Only live app-owned cards are refreshed. Model questions/history remain verbatim. */
  async refreshLocale(): Promise<void> {
    if (this.state !== "connected") return;
    const updates: Promise<void>[] = [];
    for (const entry of this.permissionCards.values()) {
      for (const sent of entry.sent) updates.push(this.updateSentCard(sent, () => this.renderPermission(entry)));
    }
    for (const entry of this.questionCards.values()) {
      if (entry.request.purpose !== "plan-approval") continue;
      for (const sent of entry.sent) updates.push(this.updateSentCard(sent, () => this.renderQuestion(entry)));
    }
    await Promise.all(updates);
  }

  private renderPermission(entry: PendingPermission): Record<string, unknown> {
    return entry.resolved
      ? resolvedCard(entry.request, entry.resolved.approved, entry.resolved.by)
      : permissionCard(entry.request);
  }

  private renderQuestion(entry: PendingQuestion): Record<string, unknown> {
    return entry.resolved ? closedQuestionCard() : questionCard(entry.request)!;
  }

  /** Serialize patches per message so a locale refresh cannot resurrect a resolved card. */
  private updateSentCard(sent: SentCard, render: () => Record<string, unknown>): Promise<void> {
    const api = this.api;
    sent.updates = sent.updates.then(async () => {
      if (!api || api !== this.api || this.state !== "connected") return;
      await this.safeSend(() => api.updateCard(sent.messageId, render()));
    });
    return sent.updates;
  }

  getState(): RemoteFeishuState {
    return this.state;
  }

  /** 状态透出（脱敏：不含 appId/appSecret；pendingBindCode 仅在连接时惰性生成） */
  getStatus(configured: boolean): RemoteFeishuStatus {
    return {
      state: this.state,
      configured,
      pendingBindCode: this.state === "connected" ? this.pendingBindCode() : null,
      allowlistCount: this.allowlist.size,
      allowlist: [...this.allowlist.values()],
    };
  }

  /** 当前有效绑定验证码；无/过期则生成新的（6 位数字，5 分钟，单次有效） */
  pendingBindCode(): string {
    if (this.bindCode && this.now() < this.bindCode.expiresAt) return this.bindCode.code;
    this.bindCode = {
      code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      expiresAt: this.now() + BIND_CODE_TTL_MS,
    };
    return this.bindCode.code;
  }

  /** 设置页白名单管理：解绑授权用户（落盘） */
  unbind(openId: string): boolean {
    if (!this.allowlist.delete(openId)) return false;
    this.persistStore();
    return true;
  }

  allowlistEntries(): RemoteFeishuAllowedUser[] {
    return [...this.allowlist.values()];
  }

  // -------------------------------------------------------------------------
  // 入站：飞书消息 → RemoteCommand
  // -------------------------------------------------------------------------

  private async handleInbound(msg: FeishuInboundMessage): Promise<void> {
    // 私聊为主：群消息一律忽略（防被拉群误触发，设计文档风险表 #8）
    if (msg.chatType && msg.chatType !== "p2p") return;
    const text = msg.text.trim();
    if (!text) return;

    // 白名单闸门：/bind 之外的非白名单消息一律忽略（首次回复一次提示）
    if (!this.allowlist.has(msg.openId)) {
      if (text.startsWith("/bind")) {
        await this.handleBind(msg.openId, text.slice(5).trim());
        return;
      }
      if (!this.notifiedUnauthorized.has(msg.openId)) {
        this.notifiedUnauthorized.add(msg.openId);
        await this.safeSend(() => this.api!.sendText(msg.openId, t("unauthorized")));
      }
      return;
    }

    try {
      if (text.startsWith("/")) await this.handleSlash(msg.openId, text);
      else await this.handlePrompt(msg.openId, text);
    } catch (err) {
      await this.safeSend(() =>
        this.api!.sendText(msg.openId, t("failed", { error: err instanceof Error ? err.message : String(err) })),
      );
    }
  }

  /** /bind <code>：验证码匹配（未过期、单次）→ 记入白名单并落盘；连续 5 次错误作废当前验证码并锁定 10 分钟 */
  private async handleBind(openId: string, code: string): Promise<void> {
    const now = this.now();
    if (now < this.bindLockedUntil) {
      await this.safeSend(() =>
        this.api!.sendText(openId, t("bind.locked", { minutes: Math.ceil((this.bindLockedUntil - now) / 60000) })),
      );
      return;
    }
    const win = this.bindCode;
    if (!win || now >= win.expiresAt || code !== win.code) {
      this.bindFailures += 1;
      if (this.bindFailures >= 5) {
        // 作废当前验证码 + 锁定 10 分钟（与桌面配对 OTP 同口径，评审 R3-C9）
        this.bindCode = null;
        this.bindFailures = 0;
        this.bindLockedUntil = now + 10 * 60_000;
      }
      await this.safeSend(() => this.api!.sendText(openId, t("bind.invalid")));
      return;
    }
    this.bindCode = null; // 单次有效：成功即作废
    this.bindFailures = 0;
    this.allowlist.set(openId, { openId, boundAt: now });
    this.persistStore();
    await this.safeSend(() => this.api!.sendText(openId, t("bind.success")));
  }

  private async handleSlash(openId: string, text: string): Promise<void> {
    const sp = text.indexOf(" ");
    const name = (sp < 0 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
    const rest = sp < 0 ? "" : text.slice(sp + 1).trim();

    switch (name) {
      case "help":
        await this.safeSend(() => this.api!.sendText(openId, t("help")));
        return;
      case "bind":
        await this.safeSend(() => this.api!.sendText(openId, t("bind.already")));
        return;
      case "new":
        await this.handleNew(openId, rest);
        return;
      case "sessions":
        await this.handleSessions(openId);
        return;
      case "use":
        await this.handleUse(openId, rest);
        return;
      case "abort":
        await this.handleAbort(openId);
        return;
      case "schedules":
        await this.handleSchedules(openId);
        return;
      case "run":
        await this.handleRun(openId, rest);
        return;
      default:
        await this.safeSend(() => this.api!.sendText(openId, t("command.unknown", { name })));
    }
  }

  /** /new <prompt>（聊天模式）或 /new -p <cwd> <prompt>（项目模式） */
  private async handleNew(openId: string, rest: string): Promise<void> {
    let mode: "chat" | "project" = "chat";
    let cwd: string | undefined;
    let prompt = rest;
    if (rest === "-p" || rest.startsWith("-p ")) {
      const body = rest.slice(2).trim();
      const sp = body.search(/\s/);
      if (sp < 0) throw new Error(t("new.projectUsage"));
      mode = "project";
      cwd = body.slice(0, sp);
      prompt = body.slice(sp + 1).trim();
    }
    if (!prompt) throw new Error(mode === "project" ? t("new.projectUsage") : t("new.chatUsage"));
    const result = (await this.dispatch(
      mode === "project" ? { type: "session.create", mode, cwd, prompt } : { type: "session.create", mode, prompt },
    )) as { sessionId: string };
    this.contexts.set(openId, result.sessionId);
    this.sessionOwners.set(result.sessionId, openId);
    const title = this.deps.registry.get(result.sessionId)?.title ?? result.sessionId.slice(0, 8);
    await this.safeSend(() => this.api!.sendText(openId, t("new.created", { title })));
  }

  /** /sessions：编号 + 状态徽章卡片；编号映射存 lastList 供 /use 使用 */
  private async handleSessions(openId: string): Promise<void> {
    const result = (await this.dispatch({ type: "session.list" })) as { sessions: SessionMeta[] };
    const sessions = result.sessions;
    if (sessions.length === 0) {
      await this.safeSend(() => this.api!.sendText(openId, t("sessions.empty")));
      return;
    }
    this.lastList.set(
      openId,
      sessions.map((s) => s.id),
    );
    const current = this.contexts.get(openId);
    const lines = sessions.map((s, i) => {
      const badge = { running: "🟢", waiting_permission: "🟡", idle: "⚪" }[this.sessionStatus.get(s.id) ?? "idle"];
      const mark = s.id === current ? ` · ${t("sessions.current")}` : "";
      return `**${i + 1}.** ${badge} ${s.title}${mark}\n\`${s.id.slice(0, 8)}\` · ${s.mode === "project" ? s.cwd : t("sessions.chat")}`;
    });
    await this.safeSend(() => this.api!.sendCard(openId, mdCard(t("sessions.title"), "blue", lines.join("\n\n"))));
  }

  /** /use <编号或 sessionId 前缀> */
  private async handleUse(openId: string, rest: string): Promise<void> {
    if (!rest) throw new Error(t("use.usage"));
    const sessions = this.deps.registry.list();
    let target: SessionMeta | undefined;
    if (/^\d+$/.test(rest)) {
      const ids = this.lastList.get(openId);
      target = ids ? sessions.find((s) => s.id === ids[Number(rest) - 1]) : undefined;
      if (!target) throw new Error(t("use.invalidNumber", { number: rest }));
    } else {
      const matches = sessions.filter((s) => s.id.startsWith(rest));
      if (matches.length > 1) throw new Error(t("use.ambiguous", { prefix: rest, count: matches.length }));
      target = matches[0];
      if (!target) throw new Error(t("use.notFound", { value: rest }));
    }
    this.contexts.set(openId, target.id);
    this.sessionOwners.set(target.id, openId);
    await this.safeSend(() => this.api!.sendText(openId, t("use.switched", { title: target.title })));
  }

  private async handleAbort(openId: string): Promise<void> {
    const sessionId = this.requireContext(openId);
    await this.dispatch({ type: "session.abort", sessionId });
    await this.safeSend(() => this.api!.sendText(openId, t("abort.sent")));
  }

  private async handleSchedules(openId: string): Promise<void> {
    const result = (await this.dispatch({ type: "schedule.list" })) as {
      tasks: import("@spcode/shared").ScheduleTask[];
    };
    if (result.tasks.length === 0) {
      await this.safeSend(() => this.api!.sendText(openId, t("schedules.empty")));
      return;
    }
    const lines = result.tasks.map((task) => {
      const state = task.enabled ? "✅" : "⏸️";
      const freq = describeFeishuSchedule(task);
      const last = task.lastStatus
        ? ` · ${t(task.lastStatus === "ok" ? "schedules.lastOk" : "schedules.lastError")}`
        : "";
      return `${state} **${task.name}** — ${freq}${last}`;
    });
    await this.safeSend(() =>
      this.api!.sendCard(
        openId,
        mdCard(t("schedules.title"), "blue", `${lines.join("\n")}\n\n${t("schedules.runHint")}`),
      ),
    );
  }

  private async handleRun(openId: string, rest: string): Promise<void> {
    if (!rest) throw new Error(t("run.usage"));
    const result = (await this.dispatch({ type: "schedule.list" })) as {
      tasks: import("@spcode/shared").ScheduleTask[];
    };
    const exact = result.tasks.find((t) => t.name === rest);
    const matches = exact ? [exact] : result.tasks.filter((t) => t.name.startsWith(rest));
    if (matches.length === 0) throw new Error(t("run.notFound", { value: rest }));
    if (matches.length > 1)
      throw new Error(t("run.ambiguous", { value: rest, names: matches.map((task) => task.name).join(", ") }));
    const run = (await this.dispatch({ type: "schedule.runNow", id: matches[0]!.id })) as { sessionId: string };
    this.contexts.set(openId, run.sessionId);
    this.sessionOwners.set(run.sessionId, openId);
    await this.safeSend(() => this.api!.sendText(openId, t("run.started", { name: matches[0]!.name })));
  }

  /** 普通文本 → session.prompt（当前会话上下文） */
  private async handlePrompt(openId: string, text: string): Promise<void> {
    const sessionId = this.contexts.get(openId);
    if (!sessionId || !this.deps.registry.get(sessionId)) {
      this.contexts.delete(openId);
      await this.safeSend(() => this.api!.sendText(openId, t("context.missing")));
      return;
    }
    await this.dispatch({ type: "session.prompt", sessionId, text });
    await this.safeSend(() => this.api!.sendText(openId, t("prompt.sent")));
  }

  private requireContext(openId: string): string {
    const sessionId = this.contexts.get(openId);
    if (!sessionId || !this.deps.registry.get(sessionId)) {
      this.contexts.delete(openId);
      throw new Error(t("context.missing"));
    }
    return sessionId;
  }

  /** 与 WS 路径同一份分发逻辑（handlers.ts 本就无连接语义，直接复用） */
  private dispatch(cmd: Parameters<typeof handleRemoteCommand>[0]): Promise<unknown> {
    return handleRemoteCommand(cmd, this.deps);
  }

  // -------------------------------------------------------------------------
  // 入站：卡片按钮回调 → permission.reply / question.reply
  // -------------------------------------------------------------------------

  private async handleCardAction(action: FeishuCardAction): Promise<void> {
    if (!this.allowlist.has(action.operatorOpenId)) return; // 非白名单操作一律忽略
    const value = action.value;
    try {
      if (value.action === "permission" && typeof value.requestId === "string") {
        const entry = this.permissionCards.get(value.requestId);
        if (
          !entry ||
          entry.submitted ||
          typeof value.approved !== "boolean" ||
          !entry.sent.some((sent) => sent.openId === action.operatorOpenId && sent.messageId === action.messageId)
        )
          return;
        entry.submitted = true;
        await this.dispatch({
          type: "permission.reply",
          requestId: value.requestId,
          approved: value.approved,
        });
        return;
      }
      if (value.action === "question" && typeof value.requestId === "string") {
        const entry = this.questionCards.get(value.requestId);
        if (
          !entry ||
          entry.submitted ||
          !entry.sent.some((sent) => sent.openId === action.operatorOpenId && sent.messageId === action.messageId)
        )
          return;
        const answers = validateQuestionAnswers(entry.request, value.answers);
        // Feishu only supports a single option button, not free text or multi-select.
        if (!answers || Object.keys(answers).length !== 1 || answers["0"]?.kind !== "options") return;
        entry.submitted = true; // lock synchronously before dispatch; duplicate callbacks fail closed
        await this.dispatch({ type: "question.reply", requestId: value.requestId, answers });
        // The host's question.resolved event is authoritative, including desktop/mobile replies and timeout.
        return;
      }
    } catch (err) {
      console.warn("[remote/feishu] 卡片回调处理失败", err);
    }
  }

  // -------------------------------------------------------------------------
  // 出站：RemoteEvent → 飞书消息（聚合器出口，400ms 窗口已在 aggregator 完成）
  // -------------------------------------------------------------------------

  private handleRemoteEvent(event: RemoteEvent): void {
    switch (event.type) {
      case "permission.request":
        void this.sendPermissionCard(event.request);
        return;
      case "permission.resolved":
        void this.resolvePermissionCard(event.requestId, event.approved, event.by);
        return;
      case "question.request":
        void this.sendQuestion(event.request);
        return;
      case "question.resolved":
        void this.resolveQuestionCard(event.requestId);
        return;
      case "session.status": {
        const prev = this.sessionStatus.get(event.sessionId);
        this.sessionStatus.set(event.sessionId, event.status);
        // 完成摘要：只在 running → idle 跳变时发一次（简单方案，见文件头注释）
        if (prev === "running" && event.status === "idle") void this.sendCompletionSummary(event.sessionId);
        return;
      }
      case "session.output": {
        const tail = (this.outputTails.get(event.sessionId) ?? "") + event.chunk;
        this.outputTails.set(event.sessionId, tail.length > OUTPUT_TAIL_MAX ? tail.slice(-OUTPUT_TAIL_MAX) : tail);
        return;
      }
      case "schedule.fired":
        void this.broadcastText(t("schedule.fired", { name: event.name }));
        return;
      default:
        // sessions.changed 等不主动推（等 /sessions 查询）
        return;
    }
  }

  private async sendPermissionCard(request: PermissionRequest): Promise<void> {
    if (this.permissionCards.has(request.requestId)) return;
    const api = this.api;
    if (!api) return;
    const entry: PendingPermission = { request, sent: [], submitted: false };
    // Register before the first network await: resolution may arrive while sending.
    this.permissionCards.set(request.requestId, entry);
    for (const openId of this.allowlist.keys()) {
      if (entry.resolved || api !== this.api) break;
      const initial = this.renderPermission(entry);
      const messageId = await this.safeSend(() => api.sendCard(openId, initial));
      if (!messageId || api !== this.api) continue;
      const sent: SentCard = { openId, messageId, updates: Promise.resolve() };
      entry.sent.push(sent);
      if (JSON.stringify(initial) !== JSON.stringify(this.renderPermission(entry))) {
        await this.updateSentCard(sent, () => this.renderPermission(entry));
      }
    }
  }

  /** Resolution is authoritative and removes the request before any patch/network await. */
  private async resolvePermissionCard(requestId: string, approved: boolean, by: "local" | "remote"): Promise<void> {
    const entry = this.permissionCards.get(requestId);
    if (!entry) return;
    entry.resolved = { approved, by };
    this.permissionCards.delete(requestId);
    await Promise.all(entry.sent.map((sent) => this.updateSentCard(sent, () => this.renderPermission(entry))));
  }

  private async resolveQuestionCard(requestId: string): Promise<void> {
    const entry = this.questionCards.get(requestId);
    if (!entry) return;
    entry.resolved = true;
    this.questionCards.delete(requestId);
    await Promise.all(entry.sent.map((sent) => this.updateSentCard(sent, () => this.renderQuestion(entry))));
  }

  private async sendQuestion(request: QuestionRequest): Promise<void> {
    const card = questionCard(request);
    if (card) {
      if (this.questionCards.has(request.requestId)) return;
      const api = this.api;
      if (!api) return;
      const entry: PendingQuestion = { request, sent: [], submitted: false, resolved: false };
      this.questionCards.set(request.requestId, entry);
      for (const openId of this.allowlist.keys()) {
        if (entry.resolved || api !== this.api) break;
        const initial = this.renderQuestion(entry);
        const messageId = await this.safeSend(() => api.sendCard(openId, initial));
        if (!messageId || api !== this.api) continue;
        const sent: SentCard = { openId, messageId, updates: Promise.resolve() };
        entry.sent.push(sent);
        if (JSON.stringify(initial) !== JSON.stringify(this.renderQuestion(entry))) {
          await this.updateSentCard(sent, () => this.renderQuestion(entry));
        }
      }
      return;
    }
    // Multi-question / multi-select / free text retain the desktop fallback, not new capabilities.
    const lines = request.questions.map((q, i) => {
      const opts = q.options
        ?.map((o) => {
          const label = o.presentation?.label ? renderMessage(o.presentation.label) : o.label;
          const description = o.presentation?.description ? renderMessage(o.presentation.description) : o.description;
          return `  - ${label}${description ? `: ${description}` : ""}`;
        })
        .join("\n");
      const question = q.presentation?.question ? renderMessage(q.presentation.question) : q.question;
      return `**${i + 1}. ${question}**${q.multiSelect ? t("question.multiple") : ""}${opts ? `\n${opts}` : ""}`;
    });
    await this.broadcastText(`${t("question.title")}:\n\n${lines.join("\n\n")}\n\n${t("question.fallback")}`);
  }

  /** 会话完成摘要：发给归属用户（无归属则不推，避免打扰全体） */
  private async sendCompletionSummary(sessionId: string): Promise<void> {
    const openId = this.sessionOwners.get(sessionId);
    if (!openId || !this.allowlist.has(openId)) return;
    const tail = this.outputTails.get(sessionId) ?? "";
    this.outputTails.delete(sessionId);
    const title = this.deps.registry.get(sessionId)?.title ?? sessionId.slice(0, 8);
    const body = tail.trim() ? `\n\n\`\`\`\n${truncate(tail.trim(), OUTPUT_TAIL_MAX)}\n\`\`\`` : "";
    await this.safeSend(() => this.api!.sendText(openId, `${t("session.completed", { title })}${body}`));
  }

  private async broadcastText(text: string): Promise<void> {
    for (const openId of this.allowlist.keys()) {
      await this.safeSend(() => this.api!.sendText(openId, text));
    }
  }

  /** 发送失败只记日志（网络抖动 / 限频），不影响主流程；返回 message_id 或 null */
  private async safeSend(fn: () => Promise<unknown>): Promise<string | null> {
    try {
      const r = await fn();
      return typeof r === "string" ? r : null;
    } catch (err) {
      console.warn("[remote/feishu] 消息发送失败", err);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 白名单持久化
  // -------------------------------------------------------------------------

  private loadStore(): void {
    const data = readJsonFile(this.storeFile, validateStore);
    // open_id 按应用隔离：appId 变了旧白名单不再生效（设计：feishu.json 含 appId 引用）
    this.allowlist = new Map(
      data && data.appId === this.cfgAppId ? data.allowlist.map((u) => [u.openId, u] as const) : [],
    );
  }

  private persistStore(): void {
    mkdirSync(dirname(this.storeFile), { recursive: true });
    const data: FeishuStoreData = { appId: this.cfgAppId, allowlist: [...this.allowlist.values()] };
    writeJsonFileAtomic(this.storeFile, data, { mode: 0o600 });
  }
}

// ---------------------------------------------------------------------------
// LarkFeishuApi：@larksuiteoapi/node-sdk 的 WebSocket 长连接实现
// （出站连接，无需公网回调地址；SDK 细节全部收敛在本类，单测不触达）
// ---------------------------------------------------------------------------

import * as Lark from "@larksuiteoapi/node-sdk";

export class LarkFeishuApi implements FeishuApi {
  private readonly client: InstanceType<typeof Lark.Client>;
  private readonly wsClient: InstanceType<typeof Lark.WSClient>;
  private messageCb: ((msg: FeishuInboundMessage) => void) | null = null;
  private cardActionCb: ((action: FeishuCardAction) => void) | null = null;

  constructor(cfg: { appId: string; appSecret: string }) {
    this.client = new Lark.Client({ appId: cfg.appId, appSecret: cfg.appSecret });
    this.wsClient = new Lark.WSClient({ appId: cfg.appId, appSecret: cfg.appSecret });
  }

  onMessage(cb: (msg: FeishuInboundMessage) => void): void {
    this.messageCb = cb;
  }

  onCardAction(cb: (action: FeishuCardAction) => void): void {
    this.cardActionCb = cb;
  }

  async start(): Promise<void> {
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        const d = data as {
          sender?: { sender_id?: { open_id?: string } };
          message?: { chat_type?: string; message_type?: string; content?: string };
        };
        const openId = d.sender?.sender_id?.open_id;
        const msg = d.message;
        if (!openId || !msg || msg.message_type !== "text" || typeof msg.content !== "string") return;
        let text = "";
        try {
          text = (JSON.parse(msg.content) as { text?: string }).text ?? "";
        } catch {
          return;
        }
        this.messageCb?.({ openId, text, chatType: msg.chat_type });
      },
      // 卡片按钮回调：SDK 长连接模式下事件名为 card.action.trigger
      "card.action.trigger": async (data: unknown) => {
        const d = data as {
          operator?: { open_id?: string };
          action?: { value?: Record<string, unknown> };
          context?: { open_message_id?: string };
          open_message_id?: string;
        };
        const openId = d.operator?.open_id;
        if (!openId) return;
        this.cardActionCb?.({
          operatorOpenId: openId,
          value: d.action?.value ?? {},
          messageId: d.context?.open_message_id ?? d.open_message_id,
        });
        // 返回空卡片响应，避免飞书端按钮转圈
        return {};
      },
    } as Parameters<InstanceType<typeof Lark.EventDispatcher>["register"]>[0]);
    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  async stop(): Promise<void> {
    // WSClient 无显式 close API（SDK 托管重连生命周期）；释放引用即可，进程退出时连接随进程关闭
    this.messageCb = null;
    this.cardActionCb = null;
  }

  async sendText(openId: string, text: string): Promise<string> {
    const res = (await this.client.im.message.create({
      params: { receive_id_type: "open_id" },
      data: { receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) },
    })) as { code?: number; msg?: string; data?: { message_id?: string } };
    if (res.code !== 0) throw new Error(t("api.sendFailed", { error: res.msg ?? `code=${res.code}` }));
    return res.data?.message_id ?? "";
  }

  async sendCard(openId: string, card: Record<string, unknown>): Promise<string> {
    const res = (await this.client.im.message.create({
      params: { receive_id_type: "open_id" },
      data: { receive_id: openId, msg_type: "interactive", content: JSON.stringify(card) },
    })) as { code?: number; msg?: string; data?: { message_id?: string } };
    if (res.code !== 0) throw new Error(t("api.cardFailed", { error: res.msg ?? `code=${res.code}` }));
    return res.data?.message_id ?? "";
  }

  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    const res = (await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    })) as { code?: number; msg?: string };
    if (res.code !== 0) throw new Error(t("api.updateFailed", { error: res.msg ?? `code=${res.code}` }));
  }
}
