/**
 * 认证快照的运行时镜像。
 *
 * RemoteServer 在构造时（宿主启动前）即订阅 AgentBridge，并一直保持订阅，远程服务
 * 暂时关闭也不会漏掉状态迁移。这样重连快照无需向 utilityProcess 增加同步查询协议，
 * 也不会把移动端的 running / waiting_permission 或待决卡片水合成陈旧状态。
 */

import type {
  HostEvent,
  PermissionRequest,
  QuestionRequest,
  RemoteSessionSnapshot,
  RemoteSessionStatus,
  SessionMeta,
} from "@spcode/shared";

export interface RemoteRuntimeSnapshot {
  sessions: RemoteSessionSnapshot[];
  pendingPermissions: PermissionRequest[];
  pendingQuestions: QuestionRequest[];
}

export class RemoteRuntimeTracker {
  private readonly running = new Set<string>();
  private readonly permissions = new Map<string, PermissionRequest>();
  private readonly questions = new Map<string, QuestionRequest>();

  handle(event: HostEvent): void {
    switch (event.type) {
      case "session.event": {
        const raw = event.event as { type?: string } | null;
        if (raw?.type === "agent_start") {
          this.running.add(event.sessionId);
        } else if (raw?.type === "agent_settled") {
          this.running.delete(event.sessionId);
          // abort/dispose 会结清宿主内请求，但权限路径不一定补发 resolved。
          // agent_settled 是该会话本轮运行的权威终点，在此统一对账。
          this.clearSessionRequests(event.sessionId);
        }
        return;
      }
      case "permission.request":
        this.permissions.set(event.request.requestId, event.request);
        return;
      case "permission.resolved":
        this.permissions.delete(event.requestId);
        return;
      case "question.request":
        this.questions.set(event.request.requestId, event.request);
        return;
      case "question.resolved":
        this.questions.delete(event.requestId);
        return;
      case "host.error":
        if (event.fatal) {
          this.running.clear();
          this.permissions.clear();
          this.questions.clear();
        }
        return;
      default:
        return;
    }
  }

  /** 与最新注册表合并，并清掉已被远端删除会话的运行时残留。 */
  snapshot(metas: SessionMeta[]): RemoteRuntimeSnapshot {
    const ids = new Set(metas.map((meta) => meta.id));
    for (const id of this.running) {
      if (!ids.has(id)) this.running.delete(id);
    }
    for (const [requestId, request] of this.permissions) {
      // 沙盒网络审批可能没有 sessionId；它不是某个已删除会话的残留，必须保留。
      if (request.sessionId && !ids.has(request.sessionId)) this.permissions.delete(requestId);
    }
    for (const [requestId, request] of this.questions) {
      if (request.sessionId && !ids.has(request.sessionId)) this.questions.delete(requestId);
    }
    return {
      sessions: metas.map((meta) => ({ ...meta, status: this.statusOf(meta.id) })),
      pendingPermissions: [...this.permissions.values()],
      pendingQuestions: [...this.questions.values()],
    };
  }

  private statusOf(sessionId: string): RemoteSessionStatus {
    for (const request of this.permissions.values()) {
      if (request.sessionId === sessionId) return "waiting_permission";
    }
    return this.running.has(sessionId) ? "running" : "idle";
  }

  private clearSessionRequests(sessionId: string): void {
    for (const [requestId, request] of this.permissions) {
      if (request.sessionId === sessionId) this.permissions.delete(requestId);
    }
    for (const [requestId, request] of this.questions) {
      if (request.sessionId === sessionId) this.questions.delete(requestId);
    }
  }
}
