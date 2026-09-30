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
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  CredentialSynchronizationError,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  HostCommand,
  HostEvent,
  ModelInfo,
  ModelRef,
  PermissionRequest,
  QuestionRequest,
} from "@spcode/shared";
import { MemoryStore } from "./memory-store.js";
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

const SPCODE_HOME = join(homedir(), ".spcode");
const AGENT_DIR = join(SPCODE_HOME, "agent");

let modelRuntime: ModelRuntime | null = null;
let memoryStore: MemoryStore | null = null;
/** 记忆蒸馏总开关（主进程设置页经 memory.setDistillEnabled 下发；宿主重启后由主进程重推） */
let distillEnabled = true;
const sessions = new Map<string, SessionController>();
/** 等待主进程裁决的权限请求 */
const pendingPermissions = new Map<string, (approved: boolean) => void>();
/** 等待用户回答的结构化提问 */
const pendingQuestions = new Map<string, (answers: Record<string, string>) => void>();

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
    pendingPermissions.set(request.requestId, resolve);
    emit({ type: "permission.request", request });
  });
}

function askQuestion(request: QuestionRequest): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    pendingQuestions.set(request.requestId, resolve);
    emit({ type: "question.request", request });
  });
}

/** session.create / session.open 公共逻辑 */
async function createController(params: {
  sessionId: string;
  cwd: string;
  mode?: "chat" | "project";
  model?: ModelRef;
  thinkingLevel?: string;
  sessionFile?: string;
  /** 恢复会话时的计划模式状态（来自注册表） */
  planMode?: boolean;
  noTitleAutomation?: boolean;
}): Promise<SessionController> {
  const rt = await getRuntime();
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
  });
}

// ---------------------------------------------------------------------------
// 命令分发
// ---------------------------------------------------------------------------

async function handleCommand(cmd: HostCommand): Promise<void> {
  // 无 id 的命令（permission.reply / shutdown）直接处理
  if (cmd.type === "permission.reply") {
    const resolve = pendingPermissions.get(cmd.payload.requestId);
    if (resolve) {
      pendingPermissions.delete(cmd.payload.requestId);
      resolve(cmd.payload.approved);
    }
    return;
  }
  if (cmd.type === "question.reply") {
    const resolve = pendingQuestions.get(cmd.payload.requestId);
    if (resolve) {
      pendingQuestions.delete(cmd.payload.requestId);
      resolve(cmd.payload.answers);
    }
    return;
  }
  if (cmd.type === "shutdown") {
    for (const s of sessions.values()) await s.dispose().catch(() => {});
    process.exit(0);
  }
  if (cmd.type === "memory.setDistillEnabled") {
    distillEnabled = cmd.payload.enabled;
    return;
  }

  const { id } = cmd;
  try {
    switch (cmd.type) {
      case "models.list": {
        const rt = await getRuntime();
        const available = await rt.getAvailable();
        respond(id, true, available.map((m) => toModelInfo(m)));
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
      case "memory.read": {
        respond(id, true, getMemoryStore().readAll());
        break;
      }
      case "theme.generate": {
        const rt = await getRuntime();
        const available = await rt.getAvailable();
        const model = available[0];
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
        const ctl = sessions.get(cmd.payload.sessionId);
        if (!ctl) throw new Error(`Session not found: ${cmd.payload.sessionId}`);
        // prompt 是长任务：立即响应"已接受"，结果通过事件流推送
        void ctl.prompt(cmd.payload.text, cmd.payload.images).catch((err) => {
          emit({ type: "host.error", message: `prompt failed: ${String(err?.message ?? err)}` });
        });
        respond(id, true, { accepted: true });
        break;
      }
      case "session.abort": {
        const ctl = sessions.get(cmd.payload.sessionId);
        if (!ctl) throw new Error(`Session not found: ${cmd.payload.sessionId}`);
        await ctl.abort();
        respond(id, true);
        break;
      }
      case "session.setModel": {
        const ctl = sessions.get(cmd.payload.sessionId);
        if (!ctl) throw new Error(`Session not found: ${cmd.payload.sessionId}`);
        await ctl.setModel(cmd.payload.model);
        respond(id, true, ctl.info());
        break;
      }
      case "session.setThinkingLevel": {
        const ctl = sessions.get(cmd.payload.sessionId);
        if (!ctl) throw new Error(`Session not found: ${cmd.payload.sessionId}`);
        ctl.setThinkingLevel(cmd.payload.level);
        respond(id, true, ctl.info());
        break;
      }
      case "session.setPlanMode": {
        const ctl = sessions.get(cmd.payload.sessionId);
        if (!ctl) throw new Error(`Session not found: ${cmd.payload.sessionId}`);
        await ctl.setPlanMode(cmd.payload.enabled);
        respond(id, true, ctl.info());
        break;
      }
      case "session.dispose": {
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

process.parentPort.once("message", () => {
  // 占位：确保 parentPort 可用
});

process.parentPort.on("message", (e: { data: unknown }) => {
  void handleCommand(e.data as HostCommand).catch((err) => {
    emit({ type: "host.error", message: err instanceof Error ? err.message : String(err) });
  });
});

// 保持 SessionManager 引用，防止被 GC（pi 依赖它做持久化）
void SessionManager;

emit({ type: "ready" });
