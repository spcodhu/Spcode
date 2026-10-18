/**
 * Web Push 服务端（M2 收尾，设计文档 4.7）：
 * - VAPID 密钥对：RemoteServer 首次启用时生成，存 ~/.spcode/remote/vapid.json
 *   （0600，原子写；损坏自动重建——重建后旧订阅全部失效，客户端会重新订阅）；
 * - 设备订阅：push.subscribe 命令按 deviceId 存 ~/.spcode/remote/push-subscriptions.json
 *   （原子写；吊销设备时同步删除）；
 * - 触发点：permission.request / question.request / schedule.fired；
 *   payload 只放通用无内容文案（"有权限请求待处理"等），**不含任何任务数据**——
 *   Apple/Google 推送通道只见元数据；
 * - 发送失败且状态码 404/410（订阅失效）时删除该订阅；推送失败不影响主流程。
 */

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostEvent, RemotePushSubscription } from "@spcode/shared";
import { readJsonFile, resolveSpcodeHome } from "@spcode/shared/node";
import webpush from "web-push";

/** VAPID subject（contact）：项目仓库地址 */
const VAPID_SUBJECT = "https://github.com/spcodhu/Spcode";

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface StoredSubscription extends RemotePushSubscription {
  updatedAt: number;
}

/** 原子写 + 0600（与 pairing.ts 同款：tmp 同目录 rename，权限钉死在两处） */
function atomicWritePrivate(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

function validateVapid(data: unknown): VapidKeys | null {
  if (!data || typeof data !== "object") return null;
  const r = data as Record<string, unknown>;
  if (typeof r.publicKey !== "string" || typeof r.privateKey !== "string" || !r.publicKey || !r.privateKey) return null;
  return { publicKey: r.publicKey, privateKey: r.privateKey };
}

function validateSubscriptions(data: unknown): Record<string, StoredSubscription> | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const out: Record<string, StoredSubscription> = {};
  for (const [deviceId, v] of Object.entries(data as Record<string, unknown>)) {
    if (!isValidSubscription(v)) return null;
    const rec = v as StoredSubscription;
    out[deviceId] = { ...rec, updatedAt: typeof rec.updatedAt === "number" ? rec.updatedAt : 0 };
  }
  return out;
}

/** PushSubscription JSON 形态校验：endpoint 必须 https，p256dh/auth 必填 */
export function isValidSubscription(v: unknown): v is RemotePushSubscription {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (typeof r.endpoint !== "string" || !r.endpoint.startsWith("https://")) return false;
  const keys = r.keys as Record<string, unknown> | undefined;
  return !!keys && typeof keys.p256dh === "string" && !!keys.p256dh && typeof keys.auth === "string" && !!keys.auth;
}

/** 事件 → 无内容推送文案（不含会话名、任务名、命令等任何业务数据） */
function payloadFor(event: HostEvent): { title: string; body: string } | null {
  switch (event.type) {
    case "permission.request":
      return { title: "Spcod", body: "有权限请求待处理" };
    case "question.request":
      return { title: "Spcod", body: "有提问待回复" };
    case "schedule.fired":
      return { title: "Spcod", body: "定时任务已触发" };
    default:
      return null;
  }
}

export class PushService {
  private readonly dir: string;
  private readonly vapidFile: string;
  private readonly subsFile: string;
  private readonly log: (msg: string, extra?: unknown) => void;
  private vapid: VapidKeys | null = null;
  private subs: Record<string, StoredSubscription> | null = null;
  private vapidConfigured = false;

  constructor(opts: { baseDir?: string; log?: (msg: string, extra?: unknown) => void } = {}) {
    this.dir = join(opts.baseDir ?? resolveSpcodeHome(), "remote");
    this.vapidFile = join(this.dir, "vapid.json");
    this.subsFile = join(this.dir, "push-subscriptions.json");
    this.log = opts.log ?? (() => {});
  }

  /** VAPID 密钥对：不存在/损坏则生成并 0600 落盘；首次生成后配置 web-push */
  ensureVapid(): VapidKeys {
    if (this.vapid) return this.vapid;
    mkdirSync(this.dir, { recursive: true });
    const loaded = readJsonFile(this.vapidFile, validateVapid);
    const keys = loaded ?? webpush.generateVAPIDKeys();
    if (!loaded) atomicWritePrivate(this.vapidFile, JSON.stringify(keys, null, 2));
    this.vapid = keys;
    if (!this.vapidConfigured) {
      webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
      this.vapidConfigured = true;
    }
    return keys;
  }

  /** remote.hello 事件携带的公钥（未初始化时先初始化） */
  vapidPublicKey(): string {
    return this.ensureVapid().publicKey;
  }

  private subscriptions(): Record<string, StoredSubscription> {
    if (this.subs) return this.subs;
    this.subs = readJsonFile(this.subsFile, validateSubscriptions) ?? {};
    return this.subs;
  }

  /** push.subscribe：按 deviceId 覆盖保存；订阅 JSON 不合法时抛错（响应 ok:false） */
  subscribe(deviceId: string, subscription: unknown): void {
    if (!isValidSubscription(subscription))
      throw new Error("非法的推送订阅（需要 endpoint / keys.p256dh / keys.auth）");
    const subs = this.subscriptions();
    subs[deviceId] = { ...subscription, updatedAt: Date.now() };
    this.persist();
  }

  /** 吊销设备时同步删除其推送订阅 */
  unsubscribeDevice(deviceId: string): void {
    const subs = this.subscriptions();
    if (!(deviceId in subs)) return;
    delete subs[deviceId];
    this.persist();
  }

  subscriptionCount(): number {
    return Object.keys(this.subscriptions()).length;
  }

  /**
   * 触发推送：只对关心的三类事件、且设置开启时发送。
   * 全部发送 Promise.allSettled 收尾，任何失败都不抛给主流程；
   * 404/410（订阅失效）删除该订阅。
   */
  async notifyForHostEvent(event: HostEvent, enabled: boolean): Promise<void> {
    if (!enabled) return;
    const payload = payloadFor(event);
    if (!payload) return;
    const subs = this.subscriptions();
    const entries = Object.entries(subs);
    if (entries.length === 0) return;
    this.ensureVapid(); // setVapidDetails 幂等兜底
    const body = JSON.stringify(payload);
    const gone: string[] = [];
    await Promise.allSettled(
      entries.map(async ([deviceId, sub]) => {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body);
        } catch (err) {
          const statusCode = (err as { statusCode?: unknown })?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            gone.push(deviceId); // 订阅失效（浏览器端退订/过期）
          } else {
            this.log("web push 发送失败", {
              deviceId,
              statusCode,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }),
    );
    if (gone.length > 0) {
      for (const id of gone) delete subs[id];
      this.persist();
    }
  }

  private persist(): void {
    mkdirSync(this.dir, { recursive: true });
    atomicWritePrivate(this.subsFile, JSON.stringify(this.subs, null, 2));
  }
}
