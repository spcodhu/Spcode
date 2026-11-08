# 远程控制安全审计自查清单

> 对应设计文档 `docs/remote-control-design.md` M3 里程碑「安全审计自查清单」逐项落地。
> 每项标注实现位置（文件:符号）与验证方式（对应测试）。发版前逐项核对。
> 最近更新：远程协议 v3 安全加固。

| # | 检查项 | 实现位置 | 验证方式 | 状态 |
|---|---|---|---|---|
| 1 | 桌面长期私钥 0600、原子写（tmp+rename），损坏自动备份重建 | `apps/desktop/src/main/remote/pairing.ts`:`PairingManager.getIdentity` / `atomicWritePrivate` | `remote-pairing.test.ts`「首次生成并 0600 落盘；同实例与新实例均读回同一身份」 | ✅ |
| 2 | 已配对设备列表原子写落盘，字段校验（id/name/公钥/pairedAt） | `pairing.ts`:`validateDevices` / `persistDevices` | `remote-pairing.test.ts`「配对成功：设备落盘（0600），新实例可读回」 | ✅ |
| 3 | OTP 8 位数字、密码学随机、单次有效（成功即关闭窗口） | `pairing.ts`:`tryPair` / `crypto.ts`:`generateOtp` | `remote-pairing.test.ts`「窗口单次有效」「OTP 生成：8 位数字，允许前导零」 | ✅ |
| 4 | OTP 5 分钟过期；窗口过期返回 `expired` | `pairing.ts`:`OTP_TTL_MS` / `currentPairing` | `remote-pairing.test.ts`「窗口过期 → expired」 | ✅ |
| 5 | OTP 连续 5 次错误锁定 10 分钟，锁定期间正确 OTP 也拒绝 | `pairing.ts`:`MAX_OTP_FAILURES` / `LOCKOUT_MS` | `remote-pairing.test.ts`「OTP 错误计数：5 次后锁定 10 分钟，正确 OTP 也被拒」 | ✅ |
| 6 | pair v3 使用 QR 带外确认的 `desktop_pk` 做 NaCl box，OTP 仅位于密文内并作在线校验，不参与密钥派生；relay 无法从密文获得离线猜测校验器 | `packages/shared/src/crypto.ts`:`sealPairHello` / `openPairHello`；`pairing.ts`:`tryPair` | `remote-crypto.test.ts` pair 往返/随机 nonce/篡改用例；`remote-pairing.test.ts` 非法密文与在线锁定用例 | ✅ |
| 7 | 会话加密 X25519 + XSalsa20-Poly1305（NaCl box），nonce 随机，篡改/错密钥静默失败 | `crypto.ts`:`boxEncrypt` / `boxDecrypt` | `remote-crypto.test.ts` 往返/篡改/错密钥三组用例 | ✅ |
| 8 | 桌面与手机均先解密加密帧，再校验并推进 seq；解密失败不推进内存或持久化防重放基线；设备出站与桌面入站序号跨连接续接 | `remote/index.ts`:`handleFrame` / `handleAuthProof`；`apps/mobile/src/lib/client.ts`:`onEncryptedFrame` | `remote-lan.test.ts`「垃圾加密帧解密失败不推进持久 seq」；`client-relay.test.ts` 入站过滤与重连续接用例 | ✅ |
| 9 | 未知公钥收到加密的失败 `auth_ack` 后断开；已配对设备须完成私钥挑战应答；已绑定连接不允许中途换设备身份 | `remote/index.ts`:`handleHello` / `handleAuthProof` | `remote-lan.test.ts` auth 与首帧用例；`client-relay.test.ts` 加密 `unknown_device` 用例 | ✅ |
| 10 | relay 不获得握手敏感载荷或业务明文：敏感内容位于 `c` 密文，外层仍暴露 channel/deviceId、帧类型、seq 等路由元数据；日志不记帧内容、票据、密钥或查询串 | `transport/relay.ts`；独立仓库 `src/index.ts`、`src/channel.ts` | `remote-relay.test.ts` 多设备隔离；独立仓库 `server.test.ts` 日志脱敏用例 | ✅ |
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
| 24 | 设备白名单/吊销：auth 仅接受已配对公钥；吊销即时断开现存桌面连接并删订阅；已签发 relay grant 不能即时撤回，但桌面拒绝后续 auth | `pairing.ts`:`findByPublicKey` / `removeDevice`；`remote/index.ts`:`unpairDevice` | `remote-pairing.test.ts`「removeDevice」；`client-relay.test.ts` 加密 `unknown_device` 用例；残余窗口见下 | ✅ |
| 25 | 设备指纹可人工核对（公钥 sha256 前 8 位 hex） | `pairing.ts`:`deviceFingerprint` | `remote-pairing.test.ts`「指纹 = 公钥 sha256 前 8 位 hex」 | ✅ |
| 26 | 依赖锁定：桌面与独立 relay 的生产依赖均固定版本，包括 tweetnacl / ws / web-push；两个仓库分别维护 lockfile | `apps/desktop/package.json`、`pnpm-lock.yaml`；`spcod-relay/package.json`、`spcod-relay/pnpm-lock.yaml` | 安装时核对锁文件；审计时分别运行依赖审计 | ✅ |
| 27 | 远程模块只在 Main 进程复用单例（不开第二进程写 ~/.spcode）；不进 agent-host / preload / renderer | `remote/index.ts` 头部注释；`main/index.ts` 接线 | 代码评审项；架构约束见设计文档 4.4 | ✅ |
| 28 | 设置页提供远程隐私说明；飞书通道明确标注消息明文经过飞书、非 E2E | `renderer/src/components/RemotePage.tsx`（`data-testid="remote-privacy"`、`data-testid="remote-feishu-privacy-warning"`） | e2e `smoke.spec.ts` 远程控制分区；隐私文案评审 | ✅ |
| 29 | host 所有权与票据：host 用桌面私钥和 `relayPk` 的共享密钥证明 channel 所有权及时间戳；票据 30 秒单次并绑定 channel/role/deviceId；自托管 accessKey 仅叠加 Bearer 校验 | `transport/relay.ts`:`issueHostTicket`；独立仓库 `src/admission.ts`、`src/tickets.ts` | 独立仓库 `tickets.test.ts` host 证明/错绑定/重放/Bearer 叠加用例；`remote-relay.test.ts` host 取票用例 | ✅ |
| 30 | relay 多设备定向离线队列：A 在线不吞 B 的帧；同 deviceId 新连接替换旧连接 | 独立仓库 `src/channel.ts` | `channel.test.ts` 多设备用例 | ✅ |
| 31 | relay 心跳与慢消费者背压；断开后由客户端权威快照/补拉恢复 | 独立仓库 `src/index.ts` | `server.test.ts`、`backpressure.test.ts` | ✅ |
| 32 | relay 配置迁移：新安装默认 official；旧 relayUrl=null 保持 LAN-only；密钥脱敏与掩码还原 | `packages/shared/src/remote.ts`、`main/settings-store.ts` | `remote-relay-config.test.ts`、`settings-security.test.ts` | ✅ |
| 33 | 手机切换 relay 不清除设备身份、输出缓存、路由或草稿 | `apps/mobile/src/state/controller.ts` | `controller-reliability.test.ts` relay 配置更新用例 | ✅ |
| 34 | 桌面打开手机创建的运行中会话不销毁 controller，不结清待决请求 | `agent-host/session-open.ts`、`agent-host/index.ts` | `session-open.test.ts`、`store-hibernation.test.ts` | ✅ |
| 35 | 双端共用 Streamdown 与亮/暗 Shiki/Mermaid，手机不再用 pre 渲染 Markdown 原文 | `packages/ui`、`apps/mobile/src/pages/SessionDetailPage.tsx` | 双端构建与 Markdown 渲染用例 | ✅ |
| 36 | 默认亮色，暗色完整覆盖；AI 主题核心令牌与 WCAG AA 对比度校验 | `packages/shared/src/theme.ts`、`renderer/theme.ts` | `theme.test.ts`、`theme-appearance.test.ts`、手机 `theme.test.ts` | ✅ |
| 37 | `pair_ack` / `auth_ack` 成功与失败均由桌面私钥加密到手机声明的公钥；手机忽略无法解密的应答，不接受伪造失败或篡改 `resumeSeq` | `remote/index.ts`:`sendHelloError` / `handleHello` / `handleAuthProof`；手机 `client.ts`:`pairWithQr` / `connectOnce` | `client-relay.test.ts` 伪造 ack、加密失败与加密 `unknown_device` 用例；`remote-lan.test.ts` auth 用例 | ✅ |
| 38 | device grant 由桌面签发并绑定 channel、deviceId/配对 subject 与 exp；QR v4 的 `relay_grant` 用于配对准入，relay 验证 grant 后才发 device 票据 | `remote/index.ts`:`pairingInfoOf` / `grantField`；`transport/relay.ts`:`issueDeviceGrant`；独立仓库 `src/admission.ts` | `remote-pairing.test.ts` QR v4；独立仓库 `tickets.test.ts` 设备令牌与跨实现向量 | ✅ |
| 39 | 设备 grant 有效期 7 天并在每次 auth 成功时滚动续期；旧 `version:1` 记录可经可用 LAN 地址 auth 升级；grant 过期后不能经 relay 自续，无可用 LAN 地址时重新扫码 | `remote/index.ts`:`DEVICE_GRANT_TTL_MS` / `grantField`；手机 `client.ts`、`db.ts` | `client-relay.test.ts`「v1 记录经 LAN auth 成功升级 v2」「relay-only 且 grant 过期进入 grant_expired」 | ✅ |
| 40 | relay 身份由持久的 `RELAY_SECRET_KEY` 派生；生产环境缺失即报错，换钥会使已签发 grant 失效并要求 LAN 续期或重新配对 | 独立仓库 `src/admission.ts`:`RelayIdentity.fromEnv`；`deploy.sh` | 独立仓库 `tickets.test.ts` 环境密钥用例；部署时检查 `deploy/relay.env` 持久化 | ✅ |
| 41 | relay 票据接口按 IP 限流，WebSocket 按 IP 限制并发连接；反代后须正确配置 `TRUST_PROXY` | 独立仓库 `src/index.ts`:`ticketRateAllowed` / `acquireConnSlot` / `requestIp` | 独立仓库 `server.test.ts` per-IP 第 N+1 条拒绝与断开恢复用例 | ✅ |
| 42 | relay 帧限流按连接隔离：device 独立令牌桶，host 桶按设备数扩容；单设备超限不影响其他设备或 host | 独立仓库 `src/channel.ts`:`buckets` / `message` | 独立仓库 `channel.test.ts`、`server.test.ts` 按连接限流用例 | ✅ |
| 43 | relay 静态响应启用 CSP：`script-src 'self'` 不含 `unsafe-inline`，首屏主题脚本外置；同时设置 `object-src 'none'`、`frame-ancestors 'none'` 等限制 | 独立仓库 `src/index.ts`:`SECURITY_HEADERS`；`apps/mobile/public/theme-boot.js` | 独立仓库 `server.test.ts`「静态资源按 MIME 服务」CSP 断言；部署后检查浏览器控制台 | ✅ |

## 已知弱点与残余边界

- 手机端私钥存 IndexedDB，PWA 无安全 enclave。XSS 或被篡改的客户端代码可读取密钥与明文，设备吊销和 CSP 不能消除该风险。
- relay 可观察连接时间、channel/deviceId 与流量元数据，并可丢帧、阻断连接或注入无效 pair 帧触发锁定。v3 准入与 E2E 不提供可用性保证；自托管只是转移控制边界。
- 被吊销设备的已签发 grant 在原过期时间前仍可进入 relay，自签发起最长 7 天；桌面会拒绝其 auth，relay 准入不能绕过桌面授权。
- relay 离线队列默认最多 72 小时在内存中保存密文及路由元数据，重启、超时或配额溢出会丢帧。
- 官方与自托管 relay 默认同源分发 PWA，因此 E2E 还需信任客户端代码分发源。自托管可控制该边界，但不保证分发源不被攻破。
- 权限 10 分钟超时手机未响应即自动拒绝——一期保持现状，后续可配置。
- `tailscale serve --bg` 写入节点持久配置，卸载应用不会自动撤销——用户在设置页关闭开关即执行 off。
