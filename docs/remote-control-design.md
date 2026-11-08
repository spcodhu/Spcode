# Spcode Harness 远程控制设计方案

> 当前实现：生产 relay 位于独立项目 `spcodhu/spcod-relay`，根仓库旧 `apps/relay/` 已删除。远程协议 v3 使用 NaCl box 配对、加密握手应答、host 所有权证明与设备准入令牌，QR 为 v4。桌面/手机支持 official/custom/disabled 三态；旧 LAN 配置不自动上公网。

> 版本：v1.0  日期：2026-10-06（v0.2：飞书补充通道 4.8 / M4 / 鸿蒙 PWA 结论；v1.0：M1–M4 全部实现，新增第 6 节实施状态与实现遗留清单）
> 目标：让用户在手机上远程操控电脑上的 Spcode harness——查看任务状态、输入提示词启动新任务（含中断后重新输入）、布置定时任务、远程批准权限确认。
> 硬性要求：**端到端加密、数据不经过开发者服务器（或经过但服务器零知识不可读）、全程开源**。

---

## 0. 结论速览（TL;DR）

1. **架构选型**：采用「Happy 模式」——桌面 harness 内嵌控制服务 + 开源哑中继（dumb relay）+ 手机端 PWA，二维码配对，X25519 + NaCl box 加密。relay 对协议业务内容保持零知识，但仍可观察连接元数据、丢弃流量；同源托管 PWA 时，也属于客户端代码分发信任边界。用户可切换到自托管 relay 或 Tailscale 直连，将官方服务移出数据路径。
2. **移动端形态**：**不建议微信小程序，首选 PWA/H5**。个人主体小程序存在三个硬伤：类目表里没有"远程控制/设备管理"（只能挂靠"工具-办公"，有被驳回风险）；UI 中展示 AI 生成内容会触发"深度合成"类目要求（个人主体无法申请）；小程序网络层强制 wss + ICP 备案域名白名单，无法直连用户电脑，反而把架构逼回"必须经过中继"。PWA 路线下开发者零备案、零服务器合规负担（代码开源分发本身不构成互联网信息服务）。
3. **代码侧改动很小**：harness 的控制面已高度收敛在 Main 进程（`AgentBridge` / `Scheduler` / `SessionRegistry` / `SettingsStore` 四个单例），远程服务只需新增一个 `src/main/remote/` 模块复用这些单例，**现有代码几乎零改动**，定时任务触发链路、权限裁决链路、中断/续输语义全部天然兼容。
4. **可达性与可用性边界**：要做到"任何网络环境下 100% 可达"，物理上必须存在一个公网中继（家庭 NAT 后的电脑无法被手机直连）。应用层 E2E 加密保护内容机密性，但不能阻止 relay 丢帧或拒绝服务。隐私说明还需列出 relay 可见的密文与连接元数据、离线队列期限，以及 PWA 代码分发信任。
5. **双通道策略（已确认都要做）**：主线是「PWA + E2E 哑 relay」（隐私最强）；补充通道是「飞书机器人」（第 4.8 节）——利用飞书开放平台的长连接模式，harness 出站直连、无需任何中继，且飞书卡片交互天然契合权限批准、推送覆盖 Android/iOS/鸿蒙三端。代价是消息以明文经过飞书（字节跳动）服务器，不满足 E2E，因此作为**默认关闭的可选通道**，设置页明确标注隐私边界。

---

## 1. 需求拆解

| 需求 | 对应现有能力 | 远程化要点 |
|---|---|---|
| 查看任务/会话状态 | `registry.list()` + `bridge.onEvent` 全量事件流 | 事件裁剪后推送到手机（流式 token 量大，需节流/聚合） |
| 输入提示词启动新任务 | `fireScheduledTask` 同款链路：`registry.upsert` → `session.create` → `session.prompt` | 远程命令直接复用 |
| 中断任务重新输入 | `session.abort` 后再 `session.prompt`；运行中 prompt 自动变 `steer` 插话 | 天然支持，协议上无需特殊设计 |
| 布置定时任务 | `scheduler.list/create/update/remove/runNow` | 远程 CRUD + 触发广播 |
| 远程批准权限确认 | `permission.request` 走 `bridge.broadcast`；`bridge.replyPermission(requestId, approved)` 回传 | 注意 10 分钟超时自动拒绝；桌面与手机双端同时弹卡，先到先得（重复回答已静默忽略，行为安全） |
| 开机并连接公网 | — | Electron 应用常驻 + 系统登录自启动（`app.setLoginItemSettings`）；relay 断线自动重连 + 离线消息队列 |

---

## 2. 市场调研结论（竞品与先例）

### 2.1 同类产品方案对比

| 产品 | 架构 | E2E | 数据过谁 | 开源 |
|---|---|---|---|---|
| **Happy Coder**（slopus/happy） | 本机 CLI + 哑 relay + Expo App，QR 配对 | ✅ tweetnacl（X25519 + XSalsa20-Poly1305）+ AES-256-GCM，会话密钥前向保密 | relay 只见密文（"We literally cannot read your code"），relay 开源可自托管 | 全栈 MIT |
| **VS Code Remote Tunnels** | 出站连 Azure dev tunnels，内层再套 SSH（AES-256-CTR） | ✅（隧道内 SSH 层） | Microsoft 只见密文 | 隧道协议实现开源 |
| **Claude Code Remote Control**（2026-02 上线） | 本地 CLI 出站轮询 Anthropic API，账号绑定 | ❌ | Anthropic 可见明文 | 否 |
| **OpenAI Codex mobile** | 手机 App 控制本机 Desktop 线程，走 OpenAI 中继 | ❌ | OpenAI 可见明文 | 否 |
| **Omnara**（YC S25） | 本地 daemon → Omnara 云 | ❌（官方明确无 E2E） | Omnara 可见明文 | 已闭源化 |
| **VibeTunnel** | 终端多路复用 + Web 化，安全外包给隧道层 | 依赖 Tailscale/ngrok | 取决于隧道商 | ✅ |
| **OpenCode** | 天然 client/server（HTTP + SSE），`opencode pair` | ❌（需自叠隧道） | 自托管则自己 | MIT |
| **Remodex / Sesori** | 开源 E2E relay（X25519 + XChaCha20-Poly1305），relay 可自托管 | ✅ | relay 只见密文 | ✅ |
| **OpenClaw 系（IM channel 模式）** | 本机 gateway + 飞书/Telegram/Discord 机器人 channel，WebSocket 长连接出站、零中继零公网地址 | ❌（明文过 IM 平台） | 飞书/腾讯/Telegram 等平台可见明文 | ✅ |

**结论**：真正做到「E2E + 数据不过开发者 + 全开源」三者兼备的公认范式就是 Happy 的三段式（本机控制端 + 哑 relay + 移动客户端，"keep the server dumb"）。大厂官方方案全部是"账号绑定 + 厂商可见明文"，不符合本项目要求。IM channel 模式（OpenClaw 已跑通飞书）以"信任 IM 平台"为代价换来零中继和原生推送，适合作为可选补充通道（见 4.8）。

### 2.2 传输层选型

| 方案 | 第三方服务器 | 明文暴露面 | 零成本适配度 |
|---|---|---|---|
| WebRTC DataChannel P2P | 信令 + STUN（极轻），打洞失败需 TURN | P2P 时无（DTLS 强制加密）；TURN 只见密文 | 打洞成功率约 70–85%，移动 CGNAT 下 25–35% 必须 TURN 兜底，**不能单独作为一期方案** |
| Tailscale（serve/funnel） | 控制面见元数据；数据面 P2P 优先 | P2P 不过任何第三方；DERP 中继只见 WireGuard 密文 | 需用户装 App + 注册账号，适合作为可选高级路径 |
| Cloudflare Tunnel / ngrok | 是 | **边缘终止 TLS，可见明文**（除非再叠应用层 E2E） | 隐私边界不理想，仅适合演示 |
| frp/nps 自建 | 用户自有 VPS | 用户自己掌控 | 违背零成本，作为高级用户可选项 |
| **哑 relay + 应用层 E2E（Happy 模式）** | 是（但零知识） | relay 只见密文 blob + 连接元数据 | **体验最顺滑，一期主线** |

**关键事实**：不存在"零服务器 + 100% 可达"的方案（大规模实测打洞条件成功率约 70%±7%，移动 CGNAT 场景更差）。务实组合：**一期 = 哑 relay（主）+ 局域网直连（自动发现）+ Tailscale（可选开关）**，传输层做成可插拔抽象；二期可加 WebRTC 直连加速层。

### 2.3 移动端形态

| 形态 | 后台/保活 | 推送 | 结论 |
|---|---|---|---|
| PWA（Android） | 前台正常，后台靠 Web Push | ✅ | 基本完整 |
| PWA（iOS） | 后台会被杀，无后台同步 | 16.4+ 支持 Web Push（须安装到主屏幕） | 可用，"打开时同步 + 推送唤醒"兜底 |
| PWA（鸿蒙） | HarmonyOS 4.x 包装为快应用快捷方式；5/6（NEXT）Petal 浏览器支持安装到桌面 | ⚠️ SW 后台同步不支持、缓存行为异常，**Web Push 大概率不可靠** | 核心功能（打开时操作）可用；推送靠 IM 兜底通道 |
| 微信小程序 | 后台约 5 分钟断连；最多 5 个并发 WS | 个人主体仅一次性订阅消息（授权一次推一条） | **不适合长连接仪表盘场景** |
| IM 机器人（飞书等） | 由 IM App 自身保活，harness 侧只需出站长连接 | ✅ 原生推送，Android/iOS/鸿蒙三端覆盖 | 体验好、零中继；代价是明文过 IM 平台（见 4.8） |
| 原生 App | 最好 | APNs/FCM | 成本最高，远期选项（可参考 Happy 用 Expo） |

---

## 3. 合规分析（微信小程序 vs PWA/H5）

### 3.1 个人主体微信小程序：卡点多、过审不确定性高

| 卡点 | 严重程度 | 说明 |
|---|---|---|
| 类目不匹配 | ★★★ | 个人类目表中**没有"远程控制/设备管理/效率"**（"设备管理""云手机"均仅企业主体，云手机还需增值电信业务许可证）；只能挂靠"工具-办公"，审核按实际功能核对，有被驳回风险 |
| AI 内容展示 | ★★★ | 微信平台审核口径：小程序内出现 AI 问答/生成内容展示 → 要求"深度合成"类目 → **个人主体无法申请**（需算法备案号或企业主体合作协议）。本场景手机端必然要展示 agent 输出，几乎必然触发 |
| 网络白名单 | ★★★ | `wx.connectSocket` 强制 **wss + ICP 备案域名白名单**（每月限改 5 次），不能用 IP/localhost；无法直连用户家庭电脑，**架构上反而被倒逼必须经过开发者中继**——与"数据不过开发者"的诉求直接冲突 |
| 小程序 ICP 备案 | ★ | 个人可办、免费、3–20 工作日，不是主要障碍 |
| 订阅消息 | ★★ | 个人主体只有"一次性订阅消息"，定时任务完成推送体验差 |
| 算法备案 | ★ | 「遥控器」架构下（AI 推理在用户自己电脑、用用户自己的 Key），依据《生成式人工智能服务管理暂行办法》第二条"向境内公众提供"的适用范围限定，开发者大概率不构成备案义务主体（高置信度推断，无监管直接案例确认）；但**平台审核口径严于法律口径**，见上 |

另有一个值得注意的信号：国家安全机关 2026 年 5 月曾发文提示远程控制软件的泄密与滥用风险，此类工具在监管视野内，平台审核趋严是大概率事件。

### 3.2 PWA/H5 路线：合规面最干净

- **开发者只发布开源代码**，Web 端由桌面应用本地启动（回环/局域网）或经加密 relay 投递：开发者零服务器、零备案、零 PIPL 负担。开源软件分发本身不构成"互联网信息服务"，无需任何备案。
- PIPL 视角：E2E 架构下开发者不接触、不决定用户数据的处理，原则上不构成这些数据的个人信息处理者；2026-09-01 起施行的小型个人信息处理者简化措施也进一步降低负担。
- 若将来要开发者托管 H5：个人 ICP 备案（免费，5–20 工作日）+ 公安联网备案（30 日内自行办理）即可，仍建议保持"遥控器"定位。

### 3.3 形态决策

**一期：PWA/H5（自托管）**。小程序降级为远期选项；若坚持做小程序，建议先注册个体工商户（成本数百元、1–2 周），解锁更匹配的类目、深度合成类目资格与长期订阅消息。

---

## 4. 总体架构设计

### 4.1 架构图

```
┌──────────────────────────── 用户电脑 ────────────────────────────┐
│  Spcode Desktop (Electron)                                       │
│  ┌─────────────┐   ┌─────────────────────────────────────────┐  │
│  │  Renderer   │←IPC│  Main 进程                               │  │
│  │  (React)    │   │  ┌─────────────┐   ┌─────────────────┐  │  │
│  └─────────────┘   │  │ AgentBridge │←──│ RemoteServer    │  │  │
│                    │  │ Scheduler   │   │ (新增模块)       │  │  │
│                    │  │ Registry    │   │ · Pairing(配对)  │  │  │
│                    │  │ Settings    │   │ · E2E 加解密     │  │  │
│                    │  └─────────────┘   │ · Transport 抽象  │  │  │
│                    │        ↑           └────────┬────────┘  │  │
│                    │  AgentHost(utilityProcess)  │            │  │
│                    └─────────────────────────────┼───────────┘  │
└──────────────────────────────────────────────────┼──────────────┘
                                                   │ wss（出站，全是密文）
                          ┌────────────────────────┴─────────┐
                          │  dumb relay（开源，可自托管）      │
                          │  · 按 channel 路由加密 blob       │
                          │  · 离线消息队列（加密存储转发）    │
                          │  · 托管 PWA 静态资源（可选）       │
                          └────────────────────────┬─────────┘
                                                   │ wss / https
                                        ┌──────────┴──────────┐
                                        │  手机端 PWA          │
                                        │  会话列表 / 状态流   │
                                        │  输入框（含中断重输）│
                                        │  定时任务管理        │
                                        │  权限批准卡          │
                                        └─────────────────────┘
```

设计原则（照 Happy 的"keep the server dumb"）：relay 不处理业务明文，只负责 v3 准入、按公钥哈希路由密文、有限期离线队列，以及可选的 PWA 静态文件分发；业务逻辑在两端。

### 4.2 配对、认证与加密协议

1. **配对（协议 v3，QR v4）**：
   - 桌面端首次启用远程功能时生成长期设备密钥对（X25519），私钥存 `~/.spcode/remote/device.key`（0600 权限）。
   - QR 为 `spcode-remote://pair?v=4&hosts=…&desktop_pk=…&otp=…`，携带局域网或 relay 地址、桌面公钥与 8 位一次性 OTP；启用 relay 时还携带 `relay_grant`，自托管访问密钥按需放在 `relay_key`。
   - 手机生成自己的 X25519 密钥对，发送 `{t:"pair", v:3, pk, c}`。`pk` 是手机公钥，`c` 是用 QR 带外可信的 `desktop_pk` 与手机私钥构造的 NaCl box，密文内只有 `{v:3, otp, name}` 等配对数据。
   - 配对帧不导出一个由 OTP 派生的加密密钥。relay 没有桌面私钥，不能解开 pair 密文，也不能利用密文离线验证 OTP 猜测；线上 pair 帧中的 OTP 仅位于密文内，桌面端在线校验受 5 分钟有效期、5 次失败锁定 10 分钟限制。安全性来自 QR 对桌面公钥的带外确认与 box 认证加密，而不是把 OTP 当作防中间人的充分条件。
   - `pair_ack` 无论成功或失败都由桌面私钥加密到手机公钥。成功密文包含桌面公钥、分配的 `deviceId`，并在 relay 可用时附带设备准入令牌；手机只接受能由对应桌面公钥解开的应答。
2. **认证与会话加密**：
   - 已配对设备先完成私钥挑战应答。`auth_ack` 无论成功或失败同样加密；成功密文包含桌面公钥、权威 `resumeSeq` 和可选的新设备准入令牌，防止伪 host 或 relay 伪造失败状态、篡改续接点。
   - 业务消息使用 NaCl box（X25519 + XSalsa20-Poly1305）与随机 nonce，携带单调递增 `seq`。桌面和手机均先成功解密，再校验并推进接收 seq；解密失败不能污染防重放基线。设备出站序号与桌面入站基线跨连接持久续接。
   - 移动端私钥存 IndexedDB（PWA 无 keychain，标记为已知弱点；原生 App 阶段换 SecureStore）。
3. **设备令牌与续期**：relay 启用时，桌面在配对成功及每次认证成功时签发有效期 7 天的设备令牌，正常重连会滚动续期。旧版浏览器配对记录（`version:1`）在仍有可用 LAN 地址时，可通过一次 LAN auth 升级为带令牌记录。令牌缺失或过期后不能经 relay 自行续期；须利用仍可用的 LAN 地址完成认证，或重新扫描 QR v4。记录没有可用 LAN 地址时只能重新扫码。
4. **离线队列**：relay 按 channel 与 deviceId 缓存密文及路由元数据，默认 TTL 为 72 小时，对端上线后补投。重启会清空内存队列，客户端通过权威快照与补拉恢复。
5. **多设备**：一个桌面端可配多台手机（device 列表管理，可逐个吊销）；每条消息按设备分别加密。吊销立即影响桌面认证和现有连接，但不能即时撤回 relay 已验证的准入令牌，残余窗口见第 5 节。

### 4.3 协议消息设计（复用 shared 包）

`packages/shared/src/index.ts` 已有的 `HostCommand` / `HostEvent` 就是现成的 envelope。远程协议 = 在加密层内传输的 JSON：

```ts
// 手机 → 桌面（明文形态，传输时整体加密）
type RemoteCommand =
  | { type: "session.list" }
  | { type: "session.create"; mode: "chat" | "project"; cwd?: string; prompt: string; model?: string }
  | { type: "session.prompt"; sessionId: string; text: string }   // 空闲=正常输入；运行中=steer 插话
  | { type: "session.abort"; sessionId: string }
  | { type: "session.subscribe"; sessionId: string }               // 订阅某会话的事件流
  | { type: "permission.reply"; requestId: string; approved: boolean }
  | { type: "question.reply"; requestId: string; answers: Record<string, string> }
  | { type: "schedule.list" | "schedule.create" | "schedule.update" | "schedule.remove" | "schedule.runNow"; /* … */ };

// 桌面 → 手机
type RemoteEvent =
  | { type: "session.snapshot"; sessions: SessionMeta[] }          // 连接后全量快照
  | { type: "session.status"; sessionId: string; status: "running" | "idle" | "waiting_permission" }
  | { type: "session.output"; sessionId: string; chunk: string; seq: number }  // 节流聚合后的输出
  | { type: "session.todo"; sessionId: string; todos: TodoItem[] }
  | { type: "permission.request"; request: PermissionRequest }     // 含 risk 级别，danger 强提示
  | { type: "question.request"; request: QuestionRequest }
  | { type: "schedule.fired"; taskId: string; name: string; sessionId: string }
  | { type: "sessions.changed" };
```

要点：
- `session.event`（pi 原生流式事件）不原样透传——token 级事件量太大。RemoteServer 内做**聚合器**：按 300–500ms 窗口把增量文本拼成 `session.output` chunk；todo/usage/planmode 等结构化事件直接映射。
- `permission.request` 必须如实透传 `risk` 级别；`danger` 级在手机上用强确认 UI（二次确认 + 显示完整命令）。
- 手机端 `permission.reply` 到达 Main 后直接调 `bridge.replyPermission(requestId, approved)`，与渲染进程完全平行；重复回答已被现有代码静默忽略（先到先得）。

### 4.4 harness 侧实现（改动面）

新增 `apps/desktop/src/main/remote/` 目录，**不改动现有模块的对外行为**：

```
src/main/remote/
├── index.ts            # RemoteServer 入口：init(settings, bridge, scheduler, registry)
├── pairing.ts          # 设备密钥、QR 生成、OTP 握手、已配对设备 CRUD
├── crypto.ts           # tweetnacl 封装：box、配对/准入 MAC、seq 防重放
├── transport/
│   ├── types.ts        # Transport 接口：connect/send/onMessage/onPeerStatus
│   ├── relay.ts        # wss → 社区/自托管 relay（一期默认）
│   ├── lan.ts          # 局域网：本地 http+ws + mDNS 广播（同网段零配置）
│   └── tailscale.ts    # 检测 tailscaled，启用则监听回环并提示 tailscale serve
├── aggregator.ts       # session.event → session.output 节流聚合
└── handlers.ts         # RemoteCommand 分发 → bridge/scheduler/registry 调用
```

接线（`src/main/index.ts` 启动序列，约 20 行新增）：

```ts
import { RemoteServer } from "./remote";
// …既有单例构造之后
const remote = new RemoteServer({ settings, bridge, scheduler, registry });
// settings.remote.enabled 为 true 时启动；设置页新增"远程控制"分区（开关、QR、设备列表、relay 地址）
```

关键实现约束（来自架构调研）：
- **必须在 Main 进程内复用现有单例**，不能开第二个进程直接改 `~/.spcode` 的 JSON（全部是"读-改-写"内存缓存模型，多进程写会互相覆盖）。
- 不要放进 agent-host（禁 import electron、崩溃即状态丢失）；不要放 preload/renderer。
- 构建：`electron.vite.config.ts` 无需改动（被 main import 即打包）；新依赖 `ws`、`tweetnacl` 进 `dependencies`（`externalizeDepsPlugin` 外部化），并确认 electron-builder 打包包含。
- 权限超时：`permission.request` 有 10 分钟自动拒绝兜底——手机端收到推送但用户 10 分钟没看，桌面侧行为不变，合理；产品上可以后续做成可配置。
- 开机自启 + 公网常驻：`app.setLoginItemSettings({ openAtLogin: true })`（macOS/Windows 均支持）+ relay 传输层指数退避自动重连。

### 4.5 relay 服务端实现

生产实现位于独立仓库 `spcodhu/spcod-relay`，根仓库不再包含 relay 服务副本：

- `GET /health`、`GET /v1/relay-info`、静态 PWA 分发；
- `POST /v1/tickets` 验证准入并签发 30 秒单次票据；
- `wss://<relay>/channel/<channelId>?role=…&ticket=…` 转发协议帧；
- 离线队列按方向与 deviceId 分槽，默认每槽最多 1000 条、TTL 72 小时，并受全局字节预算限制；
- 按 IP 限制票据请求与并发 WebSocket 数，按连接限流，提供心跳、帧大小限制与慢消费者背压。

#### 4.5.1 relay 准入 v3

- relay 持有长期 X25519 身份。桌面通过 `/v1/relay-info` 取得 `relayPk`，用桌面私钥与 `relayPk` 的共享密钥对 `channelId`、时间戳做 HMAC-SHA256，形成 host 所有权证明；relay 验证 `channelId = SHA-256(desktop_pk)` 后才签发 host 票据。
- 设备必须出示桌面签发的 device grant。令牌以同一共享密钥做 HMAC，绑定 channel、`deviceId` 或配对 subject `pair`、过期时间。QR v4 的 `relay_grant` 是随 OTP 窗口过期的配对令牌；后续设备令牌由加密的 `pair_ack` / `auth_ack` 下发。
- 官方 relay 与自托管 relay 都执行上述证明和票据校验。自托管 `accessKey` 仅作为额外 HTTP Bearer 门槛叠加，不替代 host proof 或 device grant；长期密钥不进入 WebSocket URL。
- `RELAY_SECRET_KEY` 必须跨重启和重新部署持久保存。更换它会改变 relay 身份并使现有设备 grant 失效，设备需通过 LAN auth 续期或重新扫码。

relay 不解析加密层内的业务载荷，但会处理 channel、deviceId、帧大小与时序等路由元数据。PWA 同源托管与可用性边界见第 5 节。

### 4.6 手机端 PWA 实现

- 技术栈：Vite + React + Tailwind（复用 packages/shared 的类型），构建为纯静态文件。源码放 `apps/mobile/`（monorepo 新 package）。
- 分发方式（三层，由简到繁）：
  1. **局域网**：`http://<电脑局域网IP>:<port>`（harness 内嵌静态服务 + mDNS），同 Wi-Fi 零配置；
  2. **relay 托管**：`https://spcod-relay.hlt.cab/` 打开 PWA，扫码配对后走加密通道；
  3. **用户自托管 relay**：同上，relay 地址在配对 QR 里携带。
- 核心界面（一期）：会话列表（状态徽章）→ 会话详情（输出流 + 输入框 + 中断按钮 + todo 进度）；权限批准卡（全屏强提醒）；定时任务列表/新建/启停；配对与设备管理。
- iOS 限制如实告知：PWA 须"添加到主屏幕"才有 Web Push；后台被杀后靠推送唤醒 + 打开时补拉离线队列。

### 4.7 通知推送

- 一期：PWA Web Push（VAPID；推送 payload 只放"会话 X 需要批准"这类无内容提醒，不含任务数据——Apple/Google 推送通道只见元数据）。
- 桌面端作为 VAPID 应用服务器直接发推送（经 relay 转发加密后的 push 指令），无需开发者持有推送服务。
- 可选兜底：Telegram Bot / Bark（iOS）/ 企业微信 webhook，用户自填凭据——完全用户自控，开发者不沾数据。

### 4.8 飞书机器人通道（补充通道，已确认要做）

定位：**与 PWA 并列的可选通道，默认关闭**。用"信任飞书平台"换取零中继、零公网地址、原生推送与卡片交互；隐私敏感用户继续走 PWA + E2E 主线。两条通道复用同一份 `RemoteCommand`/`RemoteEvent` handler（4.3 节的控制面与传输层本来解耦），飞书只是 Transport 的一种新实现。

**架构**：

```
harness Main 进程 ──出站 WebSocket 长连接──> 飞书开放平台 ──> 用户手机上的飞书 App
（lark-oapi SDK 长连接模式；无需公网 IP、域名、webhook，无需我们的 relay）
```

**关键事实（2026 年核实）**：

- 飞书 SDK 支持**长连接模式**接收事件（`im.message.receive_v1`）：harness 主动出站建连即可收发消息，无需公网回调地址——自建 relay 对这条通道完全不需要。
- **企业自建应用：个人账号即可创建，无需企业认证、无需飞书官方审核**（仅需租户管理员审批，而用户自己就是管理员）；不上架应用商店，因此**不需要 ICP 备案、不需要算法备案**。
- 商店应用（所有租户可装）需 ISV 企业资质认证，个人主体走不通——因此分发模式为 **BYO-app：每个用户创建自己的机器人应用**。
- 飞书**消息卡片**支持按钮与回传交互：`permission.request` 渲染为"批准/拒绝"卡片按钮，天然契合权限批准场景；流式输出用卡片更新实现（需做更新频率节流，同 4.3 聚合器）；定时任务管理用卡片菜单 + 命令（`/schedules`、`/new <prompt>`、`/abort` 等斜杠指令）。
- 推送是飞书 App 原生能力，Android/iOS/鸿蒙三端覆盖，直接补齐 PWA 在 iOS/鸿蒙上的推送短板。
- 成熟先例：OpenClaw 系产品（官方 `@openclaw/feishu` 插件）已验证该模式——WebSocket 长连接、App ID/Secret 配置、卡片交互、多通道架构，可大量参考。

**用户接入成本**（一次性，约 15–30 分钟，做成图文教程 + 权限 JSON 批量导入后接近"照抄即可"）：

1. 注册飞书并创建免费团队（租户）——已有则跳过；
2. 开放平台创建企业自建应用 → 添加"机器人"能力；
3. 开通权限（`im:message`、`im:message:send_as_bot`、`im:chat:readonly` 等，提供一键复制的批量导入 JSON）；
4. 事件订阅选"使用长连接接收事件"，添加 `im.message.receive_v1`；
5. 创建版本并发布（自己批自己）；
6. 把 App ID / App Secret 填进 harness 设置页，harness 用 lark-oapi SDK 建连。

**安全设计**：

- harness 侧维护**授权用户白名单**（飞书 user_id / open_id）：机器人只响应白名单内用户的指令，防止同租户他人或误拉入群者操控电脑；首条消息绑定流程（桌面端显示 6 位验证码，飞书里发给机器人完成绑定）。
- `danger` 级权限请求在飞书卡片上同样二次确认，完整显示命令。
- App Secret 存 `~/.spcode`（0600），与其他凭证同等保护。

**隐私边界（必须如实标注，与主线不同）**：

- 该通道下，**提示词与 agent 输出以明文经过飞书（字节跳动）服务器**，无法端到端加密（聊天终端就是飞书客户端本身）。"数据不经过**我们的**服务器"字面成立，但实质是把信任对象换成了飞书。
- 因此：通道默认关闭；开启时设置页显示明确提示（"此通道的消息内容对飞书平台可见，敏感项目请使用端到端加密的 PWA 通道"）；《远程功能隐私说明》（附录 B）包含对应条款。
- 用户可按会话粒度选择通道：敏感项目只用 PWA，日常杂事用飞书——通道选择暴露在会话创建 UI 上。

**实现落点**：`src/main/remote/transport/`（或 `channel/`）下新增 `feishu.ts`，实现与 `relay.ts` 相同的 Transport 接口；依赖 `@larksuiteoapi/node-sdk`（进 `dependencies`）。事件映射：飞书消息 → `RemoteCommand`；`RemoteEvent` → 飞书卡片/文本消息；卡片按钮回调 → `permission.reply`。

---

## 5. 隐私边界声明（重要，需如实写进 README）

**PWA + relay 主线（默认，E2E 加密）**：

| 组件 | 能看到什么 |
|---|---|
| 配对的两台设备（手机 + 电脑） | **全部明文**（这是 E2E 的两端） |
| 社区/自托管 relay | 协议密文、channel/deviceId、连接时间、流量与离线队列元数据；不能仅凭转发流量解出代码、提示词、会话内容、定时任务内容 |
| PWA 分发源 | 提供在手机端执行的客户端代码；若分发源被篡改，E2E 本身不能阻止恶意代码读取密钥或明文 |
| 推送通道（Apple/Google/Bark 等） | 无内容提醒（"有权限请求待处理"）；不含任务数据 |
| 开发者（我们） | 若用户用官方社区 relay：同上，只有元数据；若用户自托管 relay 或 Tailscale：**完全不在链路里** |
| 模型 API 厂商 | 与现状一致（用户自己的 Key 直连厂商，与远程功能无关） |

### 5.1 残余边界

- E2E 不保证可用性。relay 可以丢帧、阻断连接或注入无效 pair 帧触发配对锁定，v3 准入与加密不能消除这些拒绝服务能力。
- 吊销设备不会即时撤回已经签发的 device grant。该 grant 在原过期时间前仍可进入 relay，自签发起最长 7 天；桌面会拒绝后续 auth，因此 relay 准入不等于恢复远程控制权限。
- 离线队列默认最多 72 小时保存密文及路由元数据，且仅在内存中保存。加密不消除元数据暴露，重启或队列溢出也可能导致帧丢失。
- 官方与自托管 relay 默认同源分发 PWA。E2E 除了信任两端，还需信任实际客户端代码分发源；自托管可让用户控制这一边界，但不能消除分发源被攻破或代码被篡改的风险。



**飞书机器人通道（可选，默认关闭，非 E2E）**：

| 组件 | 能看到什么 |
|---|---|
| 飞书（字节跳动）服务器 | **提示词与 agent 输出的全部明文**（聊天终端是飞书客户端，无法端到端加密） |
| 开发者（我们） | 什么都不经过我们——通道是用户自己的 harness 与用户自己的飞书应用直连 |
| 飞书应用的 App Secret | 仅存用户本机 `~/.spcode`（0600） |

结论：官方或自托管 relay 均只承担准入、密文转发与有限期离线缓存；其运营者仍掌握可用性，并可能掌握 PWA 分发。飞书通道不经过本项目 relay，但消息明文对飞书可见。上述边界应与加密能力分别说明。

---

## 6. 分期实施计划

> 实施状态（2026-10-06 更新）：**M1–M4 已全部实现并合并**。M1=`d1cddba`+`fc7581b`+`2496004`；M2=`ddecf71`+`e420343`+`26b85ec`+`dea263e`；M3=`dea263e`+`26b85ec`；M4=`ecddbef`+`a15343c`。测试基线：desktop 232 单测 + 9 e2e、mobile 34、relay 21，typecheck/build 全绿。遗留项见文末「实现遗留清单」。

### M1：局域网版（1–1.5 周）—— 验证控制面，零合规风险 ✅
- [x] `remote/` 模块骨架 + Transport 接口 + `lan` 实现（http 静态服务 + ws + mDNS）
- [x] 局域网 QR + OTP 配对，X25519 + NaCl box 加密
- [x] RemoteCommand 全量 handler（会话 CRUD/prompt/abort、scheduler CRUD、permission/question reply）
- [x] 事件聚合器 + 手机端 PWA 最小可用版（会话列表、输出流、输入、批准卡）
- [x] 设置页"远程控制"分区（开关、QR、设备列表）
- [x] 单测：crypto 往返、aggregator 节流、handlers 对 bridge 的调用契约；e2e：模拟 WS 客户端跑通"建会话→prompt→abort→再 prompt"全链路

### M2：relay 版（1.5–2 周）—— 公网可达 ✅
- [x] relay 服务（路由 + 离线队列 + TTL）+ Dockerfile + 自托管文档；现由独立仓库 `spcod-relay` 维护
- [x] `transport/relay.ts`：出站 wss、自动重连、离线补拉（含多设备虚拟连接路由与跨连接 seq 续接）
- [x] 配对 QR 携带 relay 地址（`relay+wss://` 前缀）；relay 托管 PWA 静态资源（STATIC_DIR）
- [x] Web Push（VAPID，无内容 payload；桌面生成密钥对、404/410 订阅自动清理）
- [ ] 官方实例运行状态按发布环境验收；协议实现不以实例在线状态代替验证

### M3：加固与体验（1–2 周，可与 M2 并行排期）✅
- [x] 传输层可插拔收尾：`tailscale.ts`（检测 tailscaled + 引导 `tailscale serve`；实现为 serve 映射管理而非独立 Transport）
- [x] 定时任务移动端完整管理 UI（含创建/编辑表单与 runNow）
- [x] 权限批准双端同步撤销（`permission.resolved{requestId,approved,by}` 广播，桌面与手机互撤卡片）
- [x] 设备管理（多手机、吊销；设备指纹核对 UI 未做，列入遗留）
- [x] 安全审计自查清单：见 `docs/remote-security-checklist.md`（逐项标注实现位置与验证测试）
- [x] 《远程功能隐私说明》随应用内置（设置页可展开区）+ README 链接

### M4：飞书机器人通道（1–1.5 周，M2 之后排期；已确认要做）✅
- [x] `channel/feishu.ts`：接入 `@larksuiteoapi/node-sdk` 长连接模式（Channel 适配器，与 transport/ 平级；FeishuApi 窄接口便于测试注入）
- [x] 飞书消息 ↔ `RemoteCommand`/`RemoteEvent` 双向映射：斜杠指令（`/new`、`/use`、`/abort`、`/sessions`、`/schedules`、`/run`、`/bind`、`/help`）+ 会话归属绑定
- [x] 权限批准卡片（批准/拒绝按钮 + danger 级强提示；任一端回答后原卡片更新为终态）；输出采用"完成摘要"方案避免卡片限频
- [x] 授权用户白名单 + 首条消息 6 位验证码绑定流程（5 分钟单次有效，feishu.json 原子写 0600）
- [x] 设置页飞书分区：App ID/Secret 录入、连接状态、白名单管理、**开启时的明文提示**（"此通道消息对飞书平台可见"）
- [x] 用户接入教程 `docs/feishu-setup.md`（含权限批量导入 JSON）；隐私说明含飞书条款
- [x] 测试：FakeFeishuApi 跑通绑定/指令/权限卡片全链路（27 用例；真实长连接未对真机验证，列入遗留）

### 远期（不在本期承诺）
- 原生 App（Expo，参考 Happy）、WebRTC P2P 直连加速层、微信小程序（届时建议个体工商户主体）、更多 IM 通道（Telegram /  Discord / 企业微信，复用 M4 的 channel 抽象）

### 实现遗留清单（M1–M4 合并后盘点）
| # | 事项 | 出处 |
|---|---|---|
| L1 | 官方实例运行状态与 Docker 实机验收需按发布环境核对；生产实现由独立 `spcod-relay` 仓库维护 | M2 / relay 代理 |
| L2 | mobile `src/lib/protocol.ts` 本地类型待收敛到 `@spcode/shared` | R2a |
| L3 | 协议无 `push.unsubscribe`，退订依赖桌面侧 404/410 清理 | R2a |
| L4 | 飞书 LarkFeishuApi 真实长连接未真机验证；`card.action.trigger` 类型断言待 SDK 升级复查 | R3a |
| L5 | 飞书 question 多题/多选降级为文本引导；完成摘要只发会话归属用户 | R3a |
| L6 | 设备指纹核对 UI、relay 状态事件驱动刷新（现为 5s 轮询） | M3/R2b |
| L7 | `tailscale serve --bg` 写入节点持久配置，卸载应用不自动撤销（已记入安全清单） | R2b |

---

## 7. 风险与开放问题

| # | 问题 | 现状与建议 |
|---|---|---|
| 1 | 官方社区 relay 的运营成本与滥用 | 流量以加密控制信令与聚合文本为主；滥用防护包括 v3 准入、票据接口按 IP 限流、WebSocket per-IP 上限、按连接限流与队列配额。运营成本仍需按实际部署评估 |
| 2 | iOS PWA 体验天花板 | 后台必死，推送需安装到主屏幕。如实写入文档；重度用户引导用 Bark/Telegram 兜底通知 |
| 3 | 手机端私钥与 PWA 分发 | PWA 无安全 enclave，XSS 或恶意分发代码可丢钥、泄露明文。严格 CSP 与设备吊销只是缓解；relay 同源托管时仍需信任该代码分发源，自托管可由用户控制此边界 |
| 4 | 权限 10 分钟超时 | 手机没看到推送就自动拒绝。一期保持现状，后续做成可配置 + 超时前桌面本地兜底逻辑不变 |
| 5 | relay 元数据、可用性与吊销窗口 | relay 可见连接与流量元数据，可丢帧或拒绝服务；已签发 grant 在吊销后最长 7 天仍可入 relay，但桌面拒绝 auth。自托管只能转移控制边界，不能消除这些能力 |
| 6 | 小程序路线是否彻底放弃 | 本期放弃；若未来做，先注册个体工商户再评估类目 |
| 7 | 飞书通道的明文暴露 | 通道消息对飞书平台可见，不满足 E2E。缓解：默认关闭 + 开启时明确提示 + 会话粒度选通道；敏感项目引导走 PWA 主线 |
| 8 | 飞书通道被同租户他人滥用 | 机器人可能被拉入群或被他人 @。缓解：授权用户白名单 + 验证码绑定，非白名单指令一律忽略 |
| 9 | 飞书平台政策变化 | 长连接模式、自建应用个人可用性均依赖飞书现行政策。缓解：channel 抽象保证飞书只是可选实现，主线 PWA 不受影响 |

---

## 附录 A：主要参考来源

- Happy Coder 架构与 FAQ：https://happy.engineering/docs/how-it-works ；https://github.com/slopus/happy ；源码审计：https://nyosegawa.com/en/posts/remote-claude-code-dev-env（2026-02）
- VS Code Remote Tunnels（隧道内 SSH 提供 E2E）：https://code.visualstudio.com/docs/remote/tunnels
- Claude Code Remote Control：https://code.claude.com/docs/en/remote-control
- OpenCode server 模式：https://opencode.ai/docs/server
- NAT 打洞成功率大规模实测（约 70%±7%）：https://arxiv.org/html/2604.12484v1
- 微信小程序网络限制（wss + 备案域名白名单）：https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html
- 微信个人主体类目限制与深度合成公告：https://developers.weixin.qq.com/community/develop/doc/000eac48498a3084b3902193a69409
- 小程序 ICP 备案 FAQ：https://developers.weixin.qq.com/minigame/product/record/record_faq.html
- 订阅消息限制：https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message-overview.html
- iOS PWA 限制：https://magicbell.com/blog/pwa-ios-limitations
- 鸿蒙 PWA 支持：https://consumer.huawei.com/cn/support/content/zh-cn00448896/ ；https://bbs.itying.com/topic/6960caf3c504c50058fcef34
- 飞书长连接模式（无需公网回调地址）：https://feishu.apifox.cn/doc-7518573
- 飞书自建应用发版审核（租户管理员审批，个人可用）：https://www.feishu.cn/hc/zh-CN/articles/374230668270
- 飞书 ISV 服务商入驻（商店应用需企业资质）：https://open.feishu.cn/document/isv-guides/publish-your-app/step1-complete-the-entry
- OpenClaw 飞书 channel 实践（BYO-app 配置流程先例）：https://github.com/miaoxworld/OpenClawInstaller

## 附录 B：《远程功能隐私说明》草案（随功能内置）

> **远程控制功能隐私说明**
>
> 1. 远程功能默认关闭，由您手动开启并扫码配对后才生效。
> 2. 您的手机与电脑之间的所有通信采用端到端加密（X25519 密钥交换 + XSalsa20-Poly1305）。加密密钥仅存储在您的两台设备上，配对通过本机展示的二维码带外完成。
> 3. 为使手机在任意网络下可达您的电脑，消息会经过一台中继服务器（relay）。中继服务器转发协议密文，默认在内存离线队列中最多保存 72 小时的密文及路由元数据，并可观察连接时间和数据量。它仍可能丢帧或拒绝服务。
> 4. 您可以在设置中将中继服务器替换为自行部署的实例，或通过 Tailscale 直连，使官方服务退出数据路径。relay 默认同源分发 PWA，因此端到端加密还要求信任实际客户端代码分发源；自托管可将 relay 与代码分发置于您的控制下。
> 5. 任务通知推送（如"有权限请求待批准"）通过系统推送通道送达，推送内容不含任何任务数据。
> 6. 【可选通道】如果您选择启用飞书机器人通道：您输入的提示词与 agent 返回的内容将以**明文**经过飞书（字节跳动）的服务器，飞书平台理论上可见这些内容。此通道不经过我们运营或关联的任何服务器（连接发生在您的电脑与您自己创建的飞书应用之间）。处理敏感项目时，请改用端到端加密的 PWA 通道。飞书通道默认关闭，开启即视为知悉并接受本条。
> 7. 本功能全部代码（桌面端、中继、手机端、飞书通道）开源，欢迎审计：<仓库地址>。
> 8. 已吊销设备的既有 relay 准入令牌可能在原过期前继续有效，但桌面会拒绝其认证。relay 可用性、离线元数据和 PWA 代码分发信任不因端到端加密而消失。
