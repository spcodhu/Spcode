/**
 * 非活动会话休眠管理：宽限期计时 + 防抖动。
 *
 * 用户切走的会话先进入宽限期（默认 30s），期间被重新激活或收到任何
 * 命令都取消计时；到期才真正释放 AgentSession。避免在两个会话间
 * 快速来回切换时反复销毁重建引擎实例（每次重建都要重读会话文件）。
 */

export interface HibernationOptions {
  /** 宽限期毫秒数：到期才执行 sleep */
  graceMs: number;
  /** 到期执行真正的释放（结清待决请求 + dispose controller） */
  sleep: (sessionId: string) => Promise<void> | void;
  /** 休眠前置条件（运行中的会话不可休眠）；缺省总是允许 */
  canSleep?: (sessionId: string) => boolean;
}

export class HibernationManager {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly opts: HibernationOptions) {}

  /** 请求休眠：满足条件则进入（或重置）宽限期计时；不满足（运行中等）返回 false */
  request(sessionId: string): boolean {
    if (this.opts.canSleep && !this.opts.canSleep(sessionId)) return false;
    this.cancel(sessionId);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      void Promise.resolve(this.opts.sleep(sessionId)).catch(() => {});
    }, this.opts.graceMs);
    // 不拖住进程退出（utilityProcess 的 shutdown 路径自行 dispose 全部会话）
    timer.unref?.();
    this.timers.set(sessionId, timer);
    return true;
  }

  /** 取消待决休眠（会话被重新激活 / 收到命令时调用） */
  cancel(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  /** 是否处于宽限期（已请求但未到期） */
  pending(sessionId: string): boolean {
    return this.timers.has(sessionId);
  }

  /** 清空全部计时（宿主 shutdown 时调用；会话实例由调用方统一释放） */
  disposeAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
