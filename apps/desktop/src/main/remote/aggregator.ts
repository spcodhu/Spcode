/**
 * 事件聚合器：bridge 的全量 HostEvent → 远程协议 RemoteEvent。
 *
 * - session.event（pi 原生流式事件，token 级）不原样透传：
 *   text_delta / thinking_delta 按 400ms 窗口聚合成 session.output（每会话单调 seq）；
 *   agent_start / agent_settled 映射为 session.status（running / idle）。
 * - todo / usage / renamed / planmode 等结构化事件直接映射；
 *   permission.request / question.request 原样透传（含 risk 级别）；
 *   permission.resolved 透传（双端撤卡，见 4.3 / M3）。
 * - 非文本事件到达前先 flush 挂起的文本缓冲，保证事件时序。
 */

import type { HostEvent, RemoteEvent } from "@spcode/shared";

const DEFAULT_WINDOW_MS = 400;

type ChunkKind = "text" | "thinking";

interface PendingChunk {
  kind: ChunkKind;
  text: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface RemoteEventAggregatorOptions {
  windowMs?: number;
  emit: (event: RemoteEvent) => void;
}

export class RemoteEventAggregator {
  private readonly windowMs: number;
  private readonly emit: (event: RemoteEvent) => void;
  private readonly pending = new Map<string, PendingChunk>();
  private readonly seqs = new Map<string, number>();

  constructor(opts: RemoteEventAggregatorOptions) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.emit = opts.emit;
  }

  handle(event: HostEvent): void {
    switch (event.type) {
      case "session.event":
        this.handleSessionEvent(event.sessionId, event.event);
        break;
      case "session.todo":
        this.flush(event.sessionId);
        this.emit({ type: "session.todo", sessionId: event.sessionId, todos: event.todos });
        break;
      case "session.usage":
        this.flush(event.sessionId);
        this.emit({ type: "session.usage", sessionId: event.sessionId, usage: event.usage });
        break;
      case "session.renamed":
        this.flush(event.sessionId);
        this.emit({ type: "session.renamed", sessionId: event.sessionId, title: event.title });
        break;
      case "session.planmode":
        this.flush(event.sessionId);
        this.emit({ type: "session.planmode", sessionId: event.sessionId, enabled: event.enabled });
        break;
      case "permission.request":
        this.flush(event.request.sessionId);
        this.emit({ type: "permission.request", request: event.request });
        this.emit({ type: "session.status", sessionId: event.request.sessionId, status: "waiting_permission" });
        break;
      case "permission.resolved":
        // 双端撤卡：任一端裁决后透传给全部远程端，对端关闭同 requestId 的批准卡
        this.emit({
          type: "permission.resolved",
          requestId: event.requestId,
          approved: event.approved,
          by: event.by,
        });
        break;
      case "question.request":
        this.flush(event.request.sessionId);
        this.emit({ type: "question.request", request: event.request });
        break;
      case "schedule.fired":
        this.emit({ type: "schedule.fired", taskId: event.taskId, name: event.name, sessionId: event.sessionId });
        break;
      case "sessions.changed":
        this.emit({ type: "sessions.changed" });
        break;
      default:
        // history / plan / ready / response / host.error 不透传给远程端
        break;
    }
  }

  private handleSessionEvent(sessionId: string, raw: unknown): void {
    const e = raw as {
      type?: string;
      assistantMessageEvent?: { type?: string; delta?: string };
    } | null;
    if (!e || typeof e.type !== "string") return;
    if (e.type === "message_update" && e.assistantMessageEvent) {
      const ame = e.assistantMessageEvent;
      if (ame.type === "text_delta" && ame.delta) this.append(sessionId, "text", ame.delta);
      else if (ame.type === "thinking_delta" && ame.delta) this.append(sessionId, "thinking", ame.delta);
      return;
    }
    if (e.type === "agent_start") {
      this.flush(sessionId);
      this.emit({ type: "session.status", sessionId, status: "running" });
      return;
    }
    if (e.type === "agent_settled") {
      this.flush(sessionId);
      this.emit({ type: "session.status", sessionId, status: "idle" });
    }
  }

  private append(sessionId: string, kind: ChunkKind, delta: string): void {
    const cur = this.pending.get(sessionId);
    // text / thinking 交替时先冲刷，保证两类增量不混在同一 chunk 且时序正确
    if (cur && cur.kind !== kind) this.flush(sessionId);
    const buf = this.pending.get(sessionId);
    if (buf) {
      buf.text += delta;
      return;
    }
    const timer = setTimeout(() => this.flush(sessionId), this.windowMs);
    this.pending.set(sessionId, { kind, text: delta, timer });
  }

  /** 冲刷某会话的挂起文本缓冲（若无则空操作）；seq 每会话从 0 单调递增 */
  flush(sessionId: string): void {
    const buf = this.pending.get(sessionId);
    if (!buf) return;
    clearTimeout(buf.timer);
    this.pending.delete(sessionId);
    const seq = this.seqs.get(sessionId) ?? 0;
    this.seqs.set(sessionId, seq + 1);
    this.emit({ type: "session.output", sessionId, chunk: buf.text, kind: buf.kind, seq });
  }

  flushAll(): void {
    for (const sessionId of [...this.pending.keys()]) this.flush(sessionId);
  }

  /** 停止时清理全部定时器（不再 emit） */
  dispose(): void {
    for (const buf of this.pending.values()) clearTimeout(buf.timer);
    this.pending.clear();
  }
}
