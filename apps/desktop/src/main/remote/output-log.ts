/**
 * session.output 断线补拉缓冲（M2）：
 * RemoteServer 为每会话保留最近 N 个输出 chunk 的环形缓冲，
 * 手机端重连后用 session.output.since { afterSeq } 补拉缺口。
 *
 * 只缓冲、不持久化：进程重启后缓冲清空，手机端 afterSeq 落在范围外时
 * 拿到的是现有全部缓冲（可能不完整，由客户端决定是否回退到会话历史）。
 */

import type { RemoteOutputChunk } from "@spcode/shared";

export const OUTPUT_LOG_LIMIT = 500;

export class SessionOutputLog {
  private readonly limit: number;
  private readonly buffers = new Map<string, RemoteOutputChunk[]>();

  constructor(limit = OUTPUT_LOG_LIMIT) {
    this.limit = limit;
  }

  /** 记录一个 chunk（seq 由聚合器保证每会话单调递增） */
  append(sessionId: string, chunk: RemoteOutputChunk): void {
    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = [];
      this.buffers.set(sessionId, buf);
    }
    buf.push(chunk);
    if (buf.length > this.limit) buf.splice(0, buf.length - this.limit);
  }

  /** seq > afterSeq 的全部 chunk，按 seq 升序 */
  since(sessionId: string, afterSeq: number): RemoteOutputChunk[] {
    const buf = this.buffers.get(sessionId);
    if (!buf) return [];
    return buf.filter((c) => c.seq > afterSeq);
  }

  /** 当前缓冲的最新 seq；无缓冲返回 -1，供历史基线与实时增量对齐 */
  maxSeq(sessionId: string): number {
    return this.buffers.get(sessionId)?.at(-1)?.seq ?? -1;
  }

  /** 会话删除时释放缓冲 */
  drop(sessionId: string): void {
    this.buffers.delete(sessionId);
  }

  clear(): void {
    this.buffers.clear();
  }
}
