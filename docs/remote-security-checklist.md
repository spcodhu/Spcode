# 远程控制安全审计自查清单

> 对应设计文档 `docs/remote-control-design.md` M3 里程碑「安全审计自查清单」逐项落地。
> 每项标注实现位置（文件:符号）与验证方式（对应测试）。发版前逐项核对。
> 最近更新：2026-10-06（M2/M3 收尾）。

| # | 检查项 | 实现位置 | 验证方式 | 状态 |
|---|---|---|---|---|
| 1 | 桌面长期私钥 0600、原子写（tmp+rename），损坏自动备份重建 | `apps/desktop/src/main/remote/pairing.ts`:`PairingManager.getIdentity` / `atomicWritePrivate` | `remote-pairing.test.ts`「首次生成并 0600 落盘；同实例与新实例均读回同一身份」 | ✅ |
| 2 | 已配对设备列表原子写落盘，字段校验（id/name/公钥/pairedAt） | `pairing.ts`:`validateDevices` / `persistDevices` | `remote-pairing.test.ts`「配对成功：设备落盘（0600），新实例可读回」 | ✅ |
| 3 | OTP 8 位数字、密码学随机、单次有效（成功即关闭窗口） | `pairing.ts`:`tryPair` / `crypto.ts`:`generateOtp` | `remote-pairing.test.ts`「窗口单次有效」「OTP 生成：8 位数字，允许前导零」 | ✅ |
| 4 | OTP 5 分钟过期；窗口过期返回 `expired` | `pairing.ts`:`OTP_TTL_MS` / `currentPairing` | `remote-pairing.test.ts`「窗口过期 → expired」 | ✅ |
| 5 | OTP 连续 5 次错误锁定 10 分钟，锁定期间正确 OTP 也拒绝 | `pairing.ts`:`MAX_OTP_FAILURES` / `LOCKOUT_MS` | `remote-pairing.test.ts`「OTP 错误计数：5 次后锁定 10 分钟，正确 OTP 也被拒」 | ✅ |
| 6 | OTP 只走带外（QR/设置页），派生密钥不落地（sha256 派生仅内存） | `crypto.ts`:`deriveOtpKey` | `remote-crypto.test.ts`「同一 OTP 派生密钥可解密；不同 OTP 不可解密」 | ✅ |
| 7 | 会话加密 X25519 + XSalsa20-Poly1305（NaCl box），nonce 随机，篡改/错密钥静默失败 | `crypto.ts`:`boxEncrypt` / `boxDecrypt` | `remote-crypto.test.ts` 往返/篡改/错密钥三组用例 | ✅ |
| 8 | seq 防重放：每逻辑连接每方向严格递增，重放/乱序直接断连 | `crypto.ts`:`SeqGuard`；`remote/index.ts`:`handleFrame` | `remote-crypto.test.ts`「SeqGuard 只接受严格递增整数」；`remote-lan.test.ts`「seq 重放 → 直接断开连接」；`remote-relay.test.ts`「seq 绑定逻辑连接」 | ✅ |
| 9 | 未知公钥 auth 直接断开；已绑定连接不允许中途换设备身份 | `remote/index.ts`:`handleHello` | `remote-lan.test.ts`「auth：已配对设备凭公钥重连；未知公钥被拒并断开」「首帧不是合法 hello → 断开」 | ✅ |
| 10 | relay 零明文：帧原样穿过（pair/auth/encrypted），relay 只见密文 + deviceId 路由元数据；host 侧日志不记帧内容 | `transport/relay.ts`（全文）；日志仅记连接状态与控制帧 | `remote-relay.test.ts`「多设备隔离」（他设备帧解不开即丢弃） | ✅ |
| 11 | relay 断线出站缓冲上限 500，超限丢最旧并记日志 | `transport/relay.ts`:`pendingLimit` / `sendFrame` | `remote-relay.test.ts`「断线期间队列补投」 | ✅ |
| 12 | 静态服务防目录穿越：路径解析后强制限定 staticDir 内 | `transport/lan.ts`:`serveHttp` | `remote-lan.test.ts`「目录穿越被拒绝/无害化」 | ✅ |
| 13 | WS 仅 `/ws` 路径升级，其余 socket 直接销毁 | `transport/lan.ts`:`start`（upgrade 钩子） | `remote-lan.test.ts` 集成用例（隐式覆盖） | ✅ |
| 14 | VAPID 私钥 0600、原子写；损坏自动重建（旧订阅随之失效，客户端重订阅） | `remote/push.ts`:`PushService.ensureVapid` / `atomicWritePrivate` | `remote-push.test.ts`「VAPID 首次生成 0600 落盘，重载读回同一密钥对」 | ✅ |
| 15 | 推送订阅按 deviceId 存储、原子写；吊销设备同步删除订阅 | `remote/push.ts`:`subscribe` / `unsubscribeDevice`；`remote/index.ts`:`unpairDevice` | `remote-push.test.ts`「push.subscribe 按设备存储/覆盖」 | ✅ |
| 16 | 推送 payload 只含通用无内容文案，**不含任何任务数据**（标题/正文无会话名、任务名、命令） | `remote/push.ts`:`payloadFor` | `remote-push.test.ts`「payload 无任务数据」 | ✅ |
| 17 | 订阅失效（HTTP 404/410）自动删除；其他发送失败只记日志不影响主流程 | `remote/push.ts`:`notifyForHostEvent` | `remote-push.test.ts`「404/410 清理失效订阅」「发送失败不抛出」 | ✅ |
| 18 | 推送默认关闭（`settings.remote.pushEnabled = false`），开启才发送 | `shared/src/index.ts`:`DEFAULT_SETTINGS`；`remote/index.ts` 桥接订阅处 | `remote-push.test.ts`「pushEnabled 关闭时不发送」 | ✅ |
| 19 | Tailscale 检测全程只读（`tailscale status --json`，3s 超时），不存在/未运行视为不可用 | `transport/tailscale.ts`:`TailscaleManager.detect` | `remote-tailscale.test.ts`「未安装 tailscale → 不可用」 | ✅ |
| 20 | `tailscale serve` 仅在用户显式开启后执行；关闭执行对应 off；失败只记日志不影响主流程 | `transport/tailscale.ts`:`enable` / `disable`；`remote/index.ts`:`syncTailscale` | `remote-tailscale.test.ts`「开启执行 serve --bg --https=443」「关闭执行 off」「serve 失败返回 null」 | ✅ |
| 21 | 权限双端撤卡：一端裁决后广播 `permission.resolved`，对端自动关闭同 requestId 卡片；重复回答静默忽略 | `main/agent-bridge.ts`:`replyPermission`；`remote/aggregator.ts`:`handle`；`renderer/store.ts`:`applyHostEvent` | `remote-permission-resolved.test.ts`（bridge→remote 转发链路）；`store.test.ts` 撤卡用例 | ✅ |
| 22 | 危险命令 danger 级永远询问（act 模式也不放行），远程协议如实透传 risk 级别 | `main/agent-bridge.ts`:`adjudicate`；`shared/src/remote.ts`:`permission.request` | `risk.test.ts`；`remote-aggregator.test.ts` permission.request 透传用例 | ✅ |
| 23 | 权限请求 10 分钟超时自动拒绝兜底（手机未看推送不会永久挂死） | `main/agent-bridge.ts`:`PERMISSION_TIMEOUT_MS` / `adjudicate` | 既有 bridge 行为（评审记录）；远程端无特判 | ✅ |
| 24 | 设备白名单/吊销：auth 仅接受已配对公钥；吊销即时断开现存连接并删订阅 | `pairing.ts`:`findByPublicKey` / `removeDevice`；`remote/index.ts`:`unpairDevice` | `remote-pairing.test.ts`「removeDevice」；`remote-relay.test.ts` 多设备隔离 | ✅ |
| 25 | 设备指纹可人工核对（公钥 sha256 前 8 位 hex） | `pairing.ts`:`deviceFingerprint` | `remote-pairing.test.ts`「指纹 = 公钥 sha256 前 8 位 hex」 | ✅ |
| 26 | 依赖锁定：tweetnacl / ws / web-push 均锁版本（pnpm-lock.yaml）；relay 服务端无业务依赖外新增 | `apps/desktop/package.json`；`pnpm-lock.yaml` | 每次安装即锁定；审计时 `pnpm audit` | ✅ |
| 27 | 远程模块只在 Main 进程复用单例（不开第二进程写 ~/.spcode）；不进 agent-host / preload / renderer | `remote/index.ts` 头部注释；`main/index.ts` 接线 | 代码评审项；架构约束见设计文档 4.4 | ✅ |
| 28 | 设置页隐私说明（附录 B 全文）随应用内置、可展开；飞书条款标注“后续版本提供” | `renderer/src/components/RemotePage.tsx`（`data-testid="remote-privacy"`） | e2e `smoke.spec.ts`「远程控制分区」隐私说明展开断言 | ✅ |

## 已知弱点（设计文档第 7 节，本期接受）

- 手机端私钥存 IndexedDB（PWA 无安全 enclave，XSS 即丢钥）——缓解：PWA 仅自有源分发 + 设备吊销。
- relay 可见连接时间/流量元数据——缓解：可一键切换自托管 relay 或 Tailscale 直连。
- 权限 10 分钟超时手机未响应即自动拒绝——一期保持现状，后续可配置。
- `tailscale serve --bg` 写入节点持久配置，卸载应用不会自动撤销——用户在设置页关闭开关即执行 off。
