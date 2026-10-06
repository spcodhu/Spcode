/**
 * Web Push 订阅（M2）：
 * - 契约：auth 成功后桌面推 remote.hello（VAPID 公钥）；PWA 用 PushManager.subscribe
 *   订阅后发 push.subscribe 命令上报 subscription（桌面重启后推送路由需重建，
 *   故每次 remote.hello 且本地已开启通知时都会重新上报）；
 * - 降级：iOS 未安装 PWA / 非安全上下文 / 无 PushManager 时 isPushSupported() 为 false，
 *   UI 隐藏开关，全程静默（不报错不打扰）。
 */

const PUSH_ENABLED_KEY = "spcode.push.enabled";

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** 本地开关（用户主动开启才订阅；默认关） */
export function isPushEnabledLocally(): boolean {
  try {
    return localStorage.getItem(PUSH_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setPushEnabledLocally(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(PUSH_ENABLED_KEY, "1");
    else localStorage.removeItem(PUSH_ENABLED_KEY);
  } catch {
    // 隐私模式等：开关只活在本会话
  }
}

/** base64url → Uint8Array（PushManager.subscribe 的 applicationServerKey） */
export function urlBase64ToBytes(base64url: string): Uint8Array {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 注册最小 service worker（public/sw.js：push → 系统通知，点击聚焦 PWA） */
export async function ensureSwRegistration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register("sw.js");
  // 等 SW 激活，避免 subscribe 打在 installing 态上
  await navigator.serviceWorker.ready;
  return reg;
}

/** 订阅推送；用户拒绝授权或浏览器失败时抛错（调用方展示并维持关闭态） */
export async function subscribePush(vapidPublicKey: string): Promise<PushSubscription> {
  const reg = await ensureSwRegistration();
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToBytes(vapidPublicKey) as BufferSource,
  });
}

/** 关闭通知：退订并清本地标记（桌面侧订阅记录随连接失效，无显式下线命令） */
export async function unsubscribePush(): Promise<void> {
  setPushEnabledLocally(false);
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {
    // 退订失败不阻塞开关关闭
  }
}
