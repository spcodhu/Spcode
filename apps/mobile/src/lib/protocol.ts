/**
 * 本轮桌面侧并行新增的协议项。
 *
 * TODO(契约收敛)：packages/shared/src/remote.ts 已由桌面代理合入相同形状的定义
 * （remote.hello / push.subscribe / permission.resolved，字段名逐一核对一致）；
 * 为避免提交顺序依赖，本轮仍用本地定义，双方落地后删除本文件、改从 @spcode/shared 导入。
 */

import type { RemoteCommand, RemoteEvent } from "@spcode/shared";

/** auth 成功后桌面推送：Web Push 的 VAPID 应用服务器公钥（base64url） */
export interface RemoteHelloEvent {
  type: "remote.hello";
  vapidPublicKey: string;
}

/** 双端撤卡：某端（桌面本地 / 远程设备）已批复权限请求 */
export interface PermissionResolvedEvent {
  type: "permission.resolved";
  requestId: string;
  approved: boolean;
  by: "local" | "remote";
}

export type RemoteEventExt = RemoteEvent | RemoteHelloEvent | PermissionResolvedEvent;

/** Web Push：把 PushSubscription.toJSON() 上报复位到桌面（桌面重启后推送路由需重建） */
export interface PushSubscribeCommand {
  type: "push.subscribe";
  subscription: unknown;
}

export type RemoteCommandExt = RemoteCommand | PushSubscribeCommand;
