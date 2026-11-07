/**
 * 会话错误定时重试：~/.spcode/run-retries.json 持久化，15 秒一次 tick。
 * 到点仅负责唤醒并重新发送原指令；模型请求仍使用 pi 的正常自动重试（默认最多 3 次）。
 * 会话正在运行时顺延一分钟，不把旧指令 steer 进用户的新任务。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ImageAttachment, ScheduledRunRetry, ScheduledRunRetryInput } from "@spcode/shared";
import { i18n } from "@spcode/shared/i18n";
import { readJsonFile, resolveSpcodeHome, writeJsonFileAtomic } from "@spcode/shared/node";
import { decodeImageAttachment } from "./image-file.js";

const TICK_MS = 15_000;
const MAX_DISPATCH_ATTEMPTS = 3;

function validImages(images: unknown): boolean {
  if (images === undefined) return true;
  if (!Array.isArray(images)) return false;
  try {
    for (const image of images) decodeImageAttachment(image as ImageAttachment);
    return true;
  } catch {
    return false;
  }
}

function validRetry(value: unknown): value is ScheduledRunRetry {
  if (!value || typeof value !== "object") return false;
  const retry = value as Record<string, unknown>;
  return (
    typeof retry.id === "string" &&
    typeof retry.sessionId === "string" &&
    !!retry.sessionId &&
    typeof retry.text === "string" &&
    validImages(retry.images) &&
    typeof retry.runAt === "number" &&
    Number.isFinite(retry.runAt) &&
    typeof retry.createdAt === "number" &&
    Number.isFinite(retry.createdAt) &&
    (retry.dispatchAttempts === undefined ||
      (Number.isInteger(retry.dispatchAttempts) && (retry.dispatchAttempts as number) >= 0))
  );
}

function validateRetries(value: unknown): ScheduledRunRetry[] | null {
  return Array.isArray(value) && value.every(validRetry) ? (value as ScheduledRunRetry[]) : null;
}

export interface RunRetrySchedulerOptions {
  /** 测试覆盖存储路径。 */
  file?: string;
  /** true = 已接受；false = 会话忙，稍后顺延；抛错 = 派发失败并计一次补派。 */
  fire: (retry: ScheduledRunRetry) => Promise<boolean>;
  /** 全量快照通知，供渲染进程更新所有错误卡。 */
  notify?: (retries: ScheduledRunRetry[]) => void;
  /** 连续 3 次派发失败（与模型自动重试分开）的最终错误出口。 */
  onError?: (retry: ScheduledRunRetry, error: string) => void;
  now?: () => number;
}

export class RunRetryScheduler {
  private readonly file: string;
  private retries: ScheduledRunRetry[] | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(private readonly opts: RunRetrySchedulerOptions) {
    const dir = resolveSpcodeHome();
    mkdirSync(dir, { recursive: true });
    this.file = opts.file ?? join(dir, "run-retries.json");
  }

  list(): ScheduledRunRetry[] {
    if (!this.retries) this.retries = readJsonFile(this.file, validateRetries) ?? [];
    return this.retries;
  }

  /** 每个会话最多一条待重试；新的选择明确替换旧选择。 */
  schedule(input: ScheduledRunRetryInput): ScheduledRunRetry {
    if (
      !input ||
      typeof input.sessionId !== "string" ||
      !input.sessionId.trim() ||
      typeof input.text !== "string" ||
      (!input.text.trim() && (!Array.isArray(input.images) || input.images.length === 0)) ||
      !validImages(input.images) ||
      typeof input.runAt !== "number" ||
      !Number.isFinite(input.runAt)
    ) {
      throw new Error(i18n.t("main:scheduler.invalidRetry"));
    }
    const retry: ScheduledRunRetry = {
      id: randomUUID(),
      sessionId: input.sessionId,
      text: input.text,
      ...(input.images?.length ? { images: input.images } : {}),
      runAt: input.runAt,
      createdAt: this.opts.now?.() ?? Date.now(),
    };
    const next = this.list().filter((item) => item.sessionId !== retry.sessionId);
    next.push(retry);
    next.sort((a, b) => a.runAt - b.runAt);
    this.retries = next;
    this.persistAndNotify();
    return retry;
  }

  cancel(id: string): void {
    const next = this.list().filter((item) => item.id !== id);
    if (next.length === this.list().length) return;
    this.retries = next;
    this.persistAndNotify();
  }

  /** 用户/其他入口已开始新运行时调用，避免旧重试在之后插话。 */
  cancelForSession(sessionId: string): void {
    const next = this.list().filter((item) => item.sessionId !== sessionId);
    if (next.length === this.list().length) return;
    this.retries = next;
    this.persistAndNotify();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((error) => console.warn("[run-retry] tick 失败", error)), TICK_MS);
    void this.tick().catch((error) => console.warn("[run-retry] tick 失败", error));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.opts.now?.() ?? Date.now();
      const due = this.list()
        .filter((retry) => retry.runAt <= now)
        .sort((a, b) => a.runAt - b.runAt);
      for (const retry of due) {
        // 执行期间若被新选择替换/取消，迟到结果不得再修改新条目。
        if (!this.list().some((item) => item.id === retry.id)) continue;
        try {
          const fired = await this.opts.fire(retry);
          const current = this.list().find((item) => item.id === retry.id);
          if (!current) continue;
          if (fired) {
            this.retries = this.list().filter((item) => item.id !== retry.id);
          } else {
            current.runAt = now + 60_000;
          }
          this.persistAndNotify();
        } catch (error) {
          const current = this.list().find((item) => item.id === retry.id);
          if (!current) continue;
          const attempts = (current.dispatchAttempts ?? 0) + 1;
          const message = error instanceof Error ? error.message : String(error);
          if (attempts >= MAX_DISPATCH_ATTEMPTS) {
            this.retries = this.list().filter((item) => item.id !== retry.id);
            this.persistAndNotify();
            this.opts.onError?.(current, message);
          } else {
            current.dispatchAttempts = attempts;
            current.runAt = now + attempts * 60_000;
            this.persistAndNotify();
          }
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private persistAndNotify(): void {
    writeJsonFileAtomic(this.file, this.retries);
    this.opts.notify?.(this.list());
  }
}
