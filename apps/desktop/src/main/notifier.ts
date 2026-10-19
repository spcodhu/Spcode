/**
 * 桌面通知（评审 R3-F4）：权限请求/结构化提问/长任务完成时，窗口未聚焦才发系统通知。
 * 点击通知聚焦主窗口。macOS 上同步 Dock 徽标（待处理审批数）。
 *
 * 降噪纪律：
 * - 窗口聚焦时一律不发（用户正盯着）；
 * - 任务完成通知要求运行时长 > 15s（短回合不值得打扰）；
 * - 通知正文不含命令/输出等业务内容（只给类型与标题）。
 */
import { app, type BrowserWindow, Notification } from "electron";

/** 长跑阈值：低于此时长的回合完成不打扰 */
const LONG_RUN_MS = 15_000;

export interface NotifierDeps {
  isEnabled: () => boolean;
  getWindow: () => BrowserWindow | null;
}

export class Notifier {
  private readonly pendingApprovals = new Set<string>();
  /** sessionId → 运行开始时刻（agent_start 记录，agent_settled 结算） */
  private readonly runStartedAt = new Map<string, number>();

  constructor(private readonly deps: NotifierDeps) {}

  /** 权限/提问请求到达：窗口未聚焦时通知 + 徽标计数 */
  notifyApprovalNeeded(kind: "permission" | "question", requestId: string, title: string): void {
    this.pendingApprovals.add(requestId);
    this.syncBadge();
    if (!this.deps.isEnabled()) return;
    const win = this.deps.getWindow();
    if (win?.isFocused()) return;
    this.show(kind === "permission" ? "需要审批" : "Agent 在提问", title);
  }

  /** 审批/提问被结清（任一端裁决/超时） */
  resolveApproval(requestId: string): void {
    if (this.pendingApprovals.delete(requestId)) this.syncBadge();
  }

  /** 宿主事件流：agent_start/settled 跟踪运行时长，长任务完成且未聚焦时通知 */
  noteSessionEvent(sessionId: string, event: { type?: string }): void {
    if (event.type === "agent_start") {
      this.runStartedAt.set(sessionId, Date.now());
      return;
    }
    if (event.type !== "agent_settled") return;
    const started = this.runStartedAt.get(sessionId);
    this.runStartedAt.delete(sessionId);
    if (!started || Date.now() - started < LONG_RUN_MS) return;
    if (!this.deps.isEnabled()) return;
    const win = this.deps.getWindow();
    if (win?.isFocused()) return;
    this.show("任务完成", "会话已运行完毕，点击查看");
  }

  private show(title: string, body: string): void {
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body });
      n.on("click", () => {
        const win = this.deps.getWindow();
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.focus();
        }
      });
      n.show();
    } catch {
      // 通知失败不影响主流程
    }
  }

  /** Dock 徽标（仅 macOS）：待处理审批数；0 清除 */
  private syncBadge(): void {
    if (process.platform !== "darwin") return;
    const count = this.pendingApprovals.size;
    app.dock?.setBadge(count > 0 ? String(count) : "");
  }
}
