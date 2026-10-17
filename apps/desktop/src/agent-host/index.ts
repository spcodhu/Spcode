/**
 * Agent Host —— pi 引擎宿主，运行在 Electron utilityProcess（纯 Node 环境）。
 *
 * 职责：
 * - 持有全局唯一的 ModelRuntime（凭证/模型目录）
 * - 管理多个 SessionController（每个 Spcode 会话对应一个 pi AgentSession）
 * - 把 pi 事件流原样转发给主进程（结构化克隆）
 * - 在 beforeToolCall 钩子里挂权限网关，等待主进程裁决
 *
 * 禁止 import "electron" —— 这里只有 Node API + process.parentPort。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { CredentialSynchronizationError, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  AdvancedSearchConfig,
  HostCommand,
  HostEvent,
  ModelInfo,
  ModelRef,
  PermissionRequest,
  QuestionRequest,
  SandboxSettings,
} from "@spcode/shared";
import { DEFAULT_SANDBOX_SETTINGS } from "@spcode/shared";
import { resolveSpcodeHome } from "@spcode/shared/node";
import { HibernationManager } from "./hibernation.js";
import { MemoryStore } from "./memory-store.js";
import { getSandboxService } from "./sandbox/manager.js";
import { SessionController } from "./session-controller.js";

// ---------------------------------------------------------------------------
// 通信基座
// ---------------------------------------------------------------------------

declare const process: NodeJS.Process & {
  parentPort: {
    postMessage(msg: unknown): void;
    on(event: "message", cb: (e: { data: unknown }) => void): void;
    once(event: "message", cb: (e: { data: unknown }) => void): void;
  };
};

function emit(event: HostEvent): void {
  process.parentPort.postMessage(event);
}

function respond(id: string, success: boolean, data?: unknown, error?: string): void {
  emit({ type: "response", id, success, data, error });
}

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

const SPCODE_HOME = resolveSpcodeHome();
const AGENT_DIR = join(SPCODE_HOME, "agent");

let modelRuntime: ModelRuntime | null = null;
let memoryStore: MemoryStore | null = null;
/** 记忆蒸馏总开关（主进程设置页经 memory.setDistillEnabled 下发；宿主重启后由主进程重推） */
let distillEnabled = true;
/** 高级搜索配置（主进程设置页经 search.setAdvancedConfig 下发；宿主重启后由主进程重推） */
let advancedSearchConfig: AdvancedSearchConfig | null = null;
/** 沙盒设置（主进程设置页经 sandbox.setConfig 下发；未下发前用默认值） */
let sandboxSettings: SandboxSettings = DEFAULT_SANDBOX_SETTINGS;
const sessions = new Map<string, SessionController>();
/** 会话创建时的原始 cwd（chat 为 ""），休眠墓碑据此推断恢复模式 */
const sessionCwd = new Map<string, string>();
/** 已休眠会话的墓碑：凭 sessionFile 可在任意 session.* 命令到达时自动唤醒 */
const hibernated = new Map<string, { sessionFile: string; cwd: string; planMode: boolean }>();
/** 等待主进程裁决的权限请求（带会话归属与超时兜底——评审 P1-1） */
const pendingPermissions = new Map<
  string,
  {
    sessionId: string;
    resolve: (approved: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
/** 等待用户回答的结构化提问（同上） */
const pendingQuestions = new Map<
  string,
  {
    sessionId: string;
    resolve: (answers: Record<string, string>) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

/** 权限 10 分钟无人裁决按拒绝收尾；提问 30 分钟无人回答按"用户未答"收尾（防工具调用永久挂死） */
const PERMISSION_TIMEOUT_MS = 10 * 60_000;
const QUESTION_TIMEOUT_MS = 30 * 60_000;

async function getRuntime(): Promise<ModelRuntime> {
  if (!modelRuntime) {
    modelRuntime = await ModelRuntime.create({
      authPath: join(AGENT_DIR, "auth.json"),
      modelsPath: join(AGENT_DIR, "models.json"),
    });
  }
  return modelRuntime;
}

/**
 * 持久化 API Key 到 auth.json。
 *
 * 主路径用 rt.login("api_key")：内部走 credentials.modify 落盘，
 * 并同步模型快照/可用性。prompt 回调直接喂 UI 已收集的密钥
 * （z.ai/Moonshot/DeepSeek/Qwen 等都是 envApiKeyAuth 单 prompt 实现）。
 *
 * 兜底：少数 provider 不支持交互式 api_key 登录（纯环境变量/IAM 型），
 * 直接合并写 auth.json + setRuntimeApiKey 让运行时立即生效。
 * 写入结构 { type: "api_key", key } 已核对 pi 的 ApiKeyCredential 类型定义
 * （pi-ai/dist/auth/types.d.ts），不是盲猜——评审 P2-5。
 */
async function persistApiKey(rt: ModelRuntime, provider: string, apiKey: string): Promise<void> {
  try {
    await rt.login(provider, "api_key", {
      prompt: async () => apiKey,
      notify: () => {},
    });
    return;
  } catch (err) {
    // 凭证已落盘、仅快照同步失败 → 视为成功
    if (err instanceof CredentialSynchronizationError) return;
  }
  mkdirSync(AGENT_DIR, { recursive: true });
  const file = join(AGENT_DIR, "auth.json");
  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    } catch {
      data = {};
    }
  }
  data[provider] = { type: "api_key", key: apiKey };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, file);
  await rt.setRuntimeApiKey(provider, apiKey).catch(() => {});
}

function getMemoryStore(): MemoryStore {
  if (!memoryStore) memoryStore = new MemoryStore(SPCODE_HOME);
  return memoryStore;
}

function toModelInfo(m: {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}): ModelInfo {
  return {
    provider: m.provider,
    modelId: m.id,
    displayName: m.name ?? m.id,
    contextWindow: m.contextWindow ?? 0,
    maxTokens: m.maxTokens ?? 0,
    // 具体档位由 session 创建后按模型 clamp；这里只标注是否支持思考
    thinkingLevels: m.reasoning ? ["minimal", "low", "medium", "high", "xhigh", "max"] : [],
    available: true,
  };
}

// ---------------------------------------------------------------------------
// 权限网关
// ---------------------------------------------------------------------------

function requestPermission(request: PermissionRequest): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // 超时兜底：主进程掉线/无窗口可答时按拒绝放行，agent 循环收到"用户拒绝"后自然收尾
      if (pendingPermissions.delete(request.requestId)) resolve(false);
    }, PERMISSION_TIMEOUT_MS);
    pendingPermissions.set(request.requestId, { sessionId: request.sessionId, resolve, timer });
    emit({ type: "permission.request", request });
  });
}

function askQuestion(request: QuestionRequest): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // 空答案 = 用户未作答（工具侧渲染为 dismissed），比永久挂死更可恢复
      if (pendingQuestions.delete(request.requestId)) resolve({});
    }, QUESTION_TIMEOUT_MS);
    pendingQuestions.set(request.requestId, { sessionId: request.sessionId, resolve, timer });
    emit({ type: "question.request", request });
  });
}

/** 会话终结（dispose/abort）时结清其所有待决请求：权限按拒绝、提问按未答 */
function settlePendingForSession(sessionId: string): void {
  for (const [rid, p] of pendingPermissions) {
    if (p.sessionId !== sessionId) continue;
    pendingPermissions.delete(rid);
    clearTimeout(p.timer);
    p.resolve(false);
  }
  for (const [rid, q] of pendingQuestions) {
    if (q.sessionId !== sessionId) continue;
    pendingQuestions.delete(rid);
    clearTimeout(q.timer);
    q.resolve({});
  }
}

// ---------------------------------------------------------------------------
// 非活动会话休眠
// ---------------------------------------------------------------------------

// 沙盒网络域名审批：代理回调无法归因到具体会话，走应用级权限弹窗；
// 同意后仅本次运行生效（永久放行需用户在设置页加白名单），文案里说清这点
getSandboxService().setNetworkAskHandler((host, port) =>
  requestPermission({
    requestId: randomUUID(),
    sessionId: "",
    toolName: "network",
    args: {
      command: `网络访问 ${host}${typeof port === "number" ? `:${port}` : ""}\n（本次运行内有效；永久放行请到 设置 → 沙盒 → 网络白名单 添加）`,
      host,
      port,
    },
    risk: "outward",
    sandboxed: true,
  }),
);

/** 休眠宽限期：切走后 30s 内切回不重建引擎实例（重读会话文件很贵） */
const HIBERNATE_GRACE_MS = 30_000;

/** 到期真正释放一个会话：留墓碑（供任意命令自动唤醒），结清待决，dispose 实例 */
async function sleepSession(sessionId: string): Promise<void> {
  const ctl = sessions.get(sessionId);
  if (!ctl) return;
  if (ctl.isRunning()) return; // 宽限期内又跑起来了，放弃本次休眠
  const info = ctl.info();
  if (info.sessionFile) {
    hibernated.set(sessionId, {
      sessionFile: info.sessionFile,
      cwd: sessionCwd.get(sessionId) ?? "",
      planMode: info.planMode,
    });
  }
  settlePendingForSession(sessionId);
  await ctl.dispose().catch(() => {});
  sessions.delete(sessionId);
  sessionCwd.delete(sessionId);
}

const hibernation = new HibernationManager({
  graceMs: HIBERNATE_GRACE_MS,
  canSleep: (sessionId) => {
    const ctl = sessions.get(sessionId);
    return !!ctl && !ctl.isRunning();
  },
  sleep: sleepSession,
});

/**
 * 取活跃控制器；已休眠的按墓碑自动唤醒（远程 prompt / 定时任务等链路无感）。
 * 返回 null = 会话从未创建且无休眠墓碑（调用方按不存在报错）。
 */
async function getOrRevive(sessionId: string): Promise<SessionController | null> {
  const existing = sessions.get(sessionId);
  if (existing) {
    hibernation.cancel(sessionId);
    return existing;
  }
  const tomb = hibernated.get(sessionId);
  if (!tomb) return null;
  hibernated.delete(sessionId);
  const ctl = await createController({
    sessionId,
    cwd: tomb.cwd,
    mode: tomb.cwd.trim() ? "project" : "chat",
    sessionFile: tomb.sessionFile,
    planMode: tomb.planMode,
  });
  sessions.set(sessionId, ctl);
  // 唤醒后回放历史：渲染进程只在本地为空时采用（session.history 处理器有 guard）
  emit({ type: "session.history", sessionId, messages: ctl.history() });
  return ctl;
}

/** session.create / session.open / session.fork 公共逻辑 */
async function createController(params: {
  sessionId: string;
  cwd: string;
  mode?: "chat" | "project";
  model?: ModelRef;
  thinkingLevel?: string;
  sessionFile?: string;
  /** Fork 场景：forkFrom 复制出的现成 SessionManager（优先于 sessionFile） */
  sessionManager?: SessionManager;
  /** 恢复会话时的计划模式状态（来自注册表） */
  planMode?: boolean;
  noTitleAutomation?: boolean;
}): Promise<SessionController> {
  const rt = await getRuntime();
  sessionCwd.set(params.sessionId, params.cwd ?? "");
  return SessionController.create({
    sessionId: params.sessionId,
    cwd: params.cwd,
    agentDir: AGENT_DIR,
    modelRuntime: rt,
    memoryStore: getMemoryStore(),
    mode: params.mode,
    modelRef: params.model,
    thinkingLevel: params.thinkingLevel,
    sessionFile: params.sessionFile,
    sessionManager: params.sessionManager,
    planMode: params.planMode,
    noTitleAutomation: params.noTitleAutomation,
    emitEvent: (event) => emit({ type: "session.event", sessionId: params.sessionId, event }),
    emitUsage: (usage) => emit({ type: "session.usage", sessionId: params.sessionId, usage }),
    emitTodo: (todos) => emit({ type: "session.todo", sessionId: params.sessionId, todos }),
    emitPlanMode: (enabled) => emit({ type: "session.planmode", sessionId: params.sessionId, enabled }),
    emitPlan: (path) => emit({ type: "session.plan", sessionId: params.sessionId, path }),
    onRename: (title) => emit({ type: "session.renamed", sessionId: params.sessionId, title }),
    requestPermission,
    askQuestion,
    isDistillEnabled: () => distillEnabled,
    getAdvancedSearchConfig: () => advancedSearchConfig,
    getSandboxSettings: () => sandboxSettings,
  });
}

// ---------------------------------------------------------------------------
// 命令分发
// ---------------------------------------------------------------------------

async function handleCommand(cmd: HostCommand): Promise<void> {
  // 无 id 的命令（permission.reply / shutdown）直接处理
  if (cmd.type === "permission.reply") {
    const p = pendingPermissions.get(cmd.payload.requestId);
    if (p) {
      pendingPermissions.delete(cmd.payload.requestId);
      clearTimeout(p.timer);
      p.resolve(cmd.payload.approved);
    }
    return;
  }
  if (cmd.type === "question.reply") {
    const q = pendingQuestions.get(cmd.payload.requestId);
    if (q) {
      pendingQuestions.delete(cmd.payload.requestId);
      clearTimeout(q.timer);
      q.resolve(cmd.payload.answers);
    }
    return;
  }
  if (cmd.type === "shutdown") {
    hibernation.disposeAll();
    for (const s of sessions.values()) await s.dispose().catch(() => {});
    process.exit(0);
  }
  if (cmd.type === "memory.setDistillEnabled") {
    distillEnabled = cmd.payload.enabled;
    return;
  }
  if (cmd.type === "search.setAdvancedConfig") {
    advancedSearchConfig = cmd.payload.config;
    return;
  }
  if (cmd.type === "sandbox.setConfig") {
    sandboxSettings = cmd.payload.config;
    return;
  }

  const { id } = cmd;
  try {
    switch (cmd.type) {
      case "models.list": {
        const rt = await getRuntime();
        const available = await rt.getAvailable();
        respond(
          id,
          true,
          available.map((m) => toModelInfo(m)),
        );
        break;
      }
      case "models.catalog": {
        // 全量模型目录（含未配置密钥的厂商），模型设置页用
        const rt = await getRuntime();
        const catalog = rt.getProviders().map((p) => ({
          provider: p.id,
          name: p.name ?? p.id,
          configured: rt.hasConfiguredAuth(p.id),
          models: rt.getModels(p.id).map((m) => ({
            provider: m.provider,
            modelId: m.id,
            displayName: m.name ?? m.id,
            reasoning: !!m.reasoning,
          })),
        }));
        respond(id, true, catalog);
        break;
      }
      case "auth.setApiKey": {
        const rt = await getRuntime();
        await persistApiKey(rt, cmd.payload.provider, cmd.payload.apiKey);
        await rt.refresh({ allowNetwork: false }).catch(() => {});
        respond(id, true);
        break;
      }
      case "auth.listProviders": {
        const rt = await getRuntime();
        respond(
          id,
          true,
          rt.getProviders().map((p) => ({ id: p.id, name: p.name ?? p.id })),
        );
        break;
      }
      case "session.create": {
        // 同 sessionId 重复 create：先结清并释放旧 controller，避免 AgentSession 泄漏（评审 P2-5）
        hibernation.cancel(cmd.payload.sessionId);
        hibernated.delete(cmd.payload.sessionId);
        const existing = sessions.get(cmd.payload.sessionId);
        if (existing) {
          settlePendingForSession(cmd.payload.sessionId);
          await existing.dispose().catch(() => {});
          sessions.delete(cmd.payload.sessionId);
        }
        const ctl = await createController({
          sessionId: cmd.payload.sessionId,
          cwd: cmd.payload.cwd,
          mode: cmd.payload.mode,
          model: cmd.payload.model,
          thinkingLevel: cmd.payload.thinkingLevel,
          noTitleAutomation: cmd.payload.noTitleAutomation,
        });
        sessions.set(cmd.payload.sessionId, ctl);
        respond(id, true, ctl.info());
        break;
      }
      case "session.open": {
        // 同 sessionId 重复 open：同 create，先释放旧实例
        hibernation.cancel(cmd.payload.sessionId);
        hibernated.delete(cmd.payload.sessionId);
        const existing = sessions.get(cmd.payload.sessionId);
        if (existing) {
          settlePendingForSession(cmd.payload.sessionId);
          await existing.dispose().catch(() => {});
          sessions.delete(cmd.payload.sessionId);
        }
        const ctl = await createController({
          sessionId: cmd.payload.sessionId,
          cwd: cmd.payload.cwd,
          // 恢复会话按 cwd 推断模式（聊天会话 cwd 为空）
          mode: cmd.payload.cwd?.trim() ? "project" : "chat",
          sessionFile: cmd.payload.sessionFile,
          planMode: cmd.payload.planMode,
        });
        sessions.set(cmd.payload.sessionId, ctl);
        // 先回响应，再推历史（渲染进程按序处理）
        respond(id, true, ctl.info());
        emit({ type: "session.history", sessionId: cmd.payload.sessionId, messages: ctl.history() });
        break;
      }
      case "session.fork": {
        // 复制源会话的完整上下文（整棵会话树）到新会话文件，两会话从此独立演进
        const { sourceSessionId, newSessionId } = cmd.payload;
        // 源会话正在运行：拒绝（复制到半截流式状态语义混乱；渲染层菜单已禁用，这里兜底）
        const srcCtl = sessions.get(sourceSessionId);
        if (srcCtl?.isRunning()) throw new Error("会话正在运行，请先停止再分叉");
        const sourceFile = cmd.payload.sourceSessionFile;
        if (!sourceFile || !existsSync(sourceFile) || statSync(sourceFile).size === 0) {
          throw new Error("该会话还没有可分叉的内容（会话记录为空）");
        }
        // 同 newSessionId 重复 fork：先结清并释放旧实例，避免 AgentSession 泄漏（同 create/open）
        hibernation.cancel(newSessionId);
        hibernated.delete(newSessionId);
        const existingFork = sessions.get(newSessionId);
        if (existingFork) {
          settlePendingForSession(newSessionId);
          await existingFork.dispose().catch(() => {});
          sessions.delete(newSessionId);
        }
        // sessionDir 必须显式传源文件所在目录：forkFrom 内部 getDefaultSessionDir 不带
        // agentDir，不传会落到 pi 默认目录（~/.pi/agent/sessions/）而不是 ~/.spcode/...
        const forkCwd = cmd.payload.cwd?.trim() ? cmd.payload.cwd : join(AGENT_DIR, "..", "scratch");
        const forkedManager = SessionManager.forkFrom(sourceFile, forkCwd, dirname(sourceFile), {
          id: newSessionId,
          parentSession: sourceFile,
        });
        const ctl = await createController({
          sessionId: newSessionId,
          cwd: cmd.payload.cwd ?? "",
          mode: cmd.payload.mode,
          model: cmd.payload.model,
          thinkingLevel: cmd.payload.thinkingLevel,
          sessionManager: forkedManager,
          planMode: cmd.payload.planMode,
        });
        sessions.set(newSessionId, ctl);
        respond(id, true, ctl.info());
        // Fork 出的会话自带完整历史（渲染进程按序处理：先响应后历史）
        emit({ type: "session.history", sessionId: newSessionId, messages: ctl.history() });
        break;
      }
      case "session.hibernate": {
        // 渲染进程切换会话后请求休眠：进入宽限期计时；运行中/不存在则拒睡
        const scheduled = hibernation.request(cmd.payload.sessionId);
        respond(id, true, { scheduled, already: hibernated.has(cmd.payload.sessionId) });
        break;
      }
      case "session.activate": {
        // 幂等唤醒：已有活跃实例直接回 info；已休眠清墓碑按 sessionFile 恢复
        hibernation.cancel(cmd.payload.sessionId);
        const existing = sessions.get(cmd.payload.sessionId);
        if (existing) {
          respond(id, true, existing.info());
          break;
        }
        hibernated.delete(cmd.payload.sessionId);
        const ctl = await createController({
          sessionId: cmd.payload.sessionId,
          cwd: cmd.payload.cwd,
          mode: cmd.payload.cwd?.trim() ? "project" : "chat",
          sessionFile: cmd.payload.sessionFile,
          planMode: cmd.payload.planMode,
        });
        sessions.set(cmd.payload.sessionId, ctl);
        respond(id, true, ctl.info());
        // 历史回放：渲染进程只在本地消息为空时采用（重复激活不会刷掉现有消息）
        emit({ type: "session.history", sessionId: cmd.payload.sessionId, messages: ctl.history() });
        break;
      }
      case "memory.read": {
        respond(id, true, getMemoryStore().readAll());
        break;
      }
      case "theme.generate": {
        const rt = await getRuntime();
        const available = await rt.getAvailable();
        // 优先用调用方指定的模型（设置页默认模型）；指定模型当前不可用时退回列表首个
        const want = cmd.payload.model;
        const model =
          (want && available.find((m) => m.provider === want.provider && m.id === want.modelId)) || available[0];
        if (!model) throw new Error("没有可用模型，请先在设置里配置 API Key");
        const prompt = [
          "你是一个桌面应用主题设计师。根据用户的描述生成一个暗色主题 JSON。",
          "严格只输出 JSON（不要 markdown 代码块），格式：",
          '{"name":"主题名","base":"dark","colors":{"bgRoot":"#...","bgSidebar":"#...","bgMain":"#...","bgElevated":"#...","bgHover":"#...","bgActive":"#...","border":"#...","textPrimary":"#...","textSecondary":"#...","textTertiary":"#...","accent":"#...","danger":"#...","warning":"#...","success":"#..."}}',
          "要求：背景层级分明（root 最深、elevated 最浅）、正文对比度 ≥ 7:1、accent 一个主色、低饱和长看不累。",
          `用户描述：${cmd.payload.description}`,
        ].join("\n");
        const result = await rt.completeSimple(model, {
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        });
        const text = result.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
        const jsonMatch = /\{[\s\S]*\}/.exec(text);
        if (!jsonMatch) throw new Error("模型未返回有效 JSON");
        const theme = JSON.parse(jsonMatch[0]) as unknown;
        respond(id, true, theme);
        break;
      }
      case "session.prompt": {
        const ctl = await getOrRevive(cmd.payload.sessionId);
        if (!ctl) throw new Error(`Session not found: ${cmd.payload.sessionId}`);
        // prompt 是长任务：立即响应"已接受"，结果通过事件流推送
        void ctl.prompt(cmd.payload.text, cmd.payload.images).catch((err) => {
          emit({ type: "host.error", message: `prompt failed: ${String(err?.message ?? err)}` });
        });
        respond(id, true, { accepted: true });
        break;
      }
      case "session.abort": {
        // 已休眠的会话没有可中止的运行：取消待决休眠并按成功收尾（幂等）
        hibernation.cancel(cmd.payload.sessionId);
        const ctl = sessions.get(cmd.payload.sessionId);
        if (ctl) {
          // abort 后工具调用链被掐断，挂起的权限/提问按拒绝/未答结清
          settlePendingForSession(cmd.payload.sessionId);
          await ctl.abort();
        }
        respond(id, true);
        break;
      }
      case "session.setModel": {
        const ctl = await getOrRevive(cmd.payload.sessionId);
        if (!ctl) throw new Error(`Session not found: ${cmd.payload.sessionId}`);
        await ctl.setModel(cmd.payload.model);
        respond(id, true, ctl.info());
        break;
      }
      case "session.setThinkingLevel": {
        const ctl = await getOrRevive(cmd.payload.sessionId);
        if (!ctl) throw new Error(`Session not found: ${cmd.payload.sessionId}`);
        ctl.setThinkingLevel(cmd.payload.level);
        respond(id, true, ctl.info());
        break;
      }
      case "session.setPlanMode": {
        const ctl = await getOrRevive(cmd.payload.sessionId);
        if (!ctl) throw new Error(`Session not found: ${cmd.payload.sessionId}`);
        await ctl.setPlanMode(cmd.payload.enabled);
        respond(id, true, ctl.info());
        break;
      }
      case "session.dispose": {
        // 先结清该会话的待决权限/提问，再拆 controller——否则 beforeToolCall 永远悬停（评审 P1-1）
        hibernation.cancel(cmd.payload.sessionId);
        hibernated.delete(cmd.payload.sessionId);
        sessionCwd.delete(cmd.payload.sessionId);
        settlePendingForSession(cmd.payload.sessionId);
        const ctl = sessions.get(cmd.payload.sessionId);
        if (ctl) {
          await ctl.dispose();
          sessions.delete(cmd.payload.sessionId);
        }
        respond(id, true);
        break;
      }
      default: {
        const neverCmd: never = cmd;
        respond(id, false, undefined, `Unknown command: ${JSON.stringify(neverCmd)}`);
      }
    }
  } catch (err) {
    respond(id, false, undefined, err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

process.parentPort.on("message", (e: { data: unknown }) => {
  void handleCommand(e.data as HostCommand).catch((err) => {
    emit({ type: "host.error", message: err instanceof Error ? err.message : String(err) });
  });
});

// 保持 SessionManager 引用，防止被 GC（pi 依赖它做持久化）
void SessionManager;

emit({ type: "ready" });
