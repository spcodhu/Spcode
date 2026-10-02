# Spcode Harness 远程控制设计方案

> 版本：v0.1（设计稿）  日期：2026-10-02
> 目标：让用户在手机上远程操控电脑上的 Spcode harness——查看任务状态、输入提示词启动新任务（含中断后重新输入）、布置定时任务、远程批准权限确认。
> 硬性要求：**端到端加密、数据不经过开发者服务器（或经过但服务器零知识不可读）、全程开源**。

---

## 0. 结论速览（TL;DR）

1. **架构选型**：采用「Happy 模式」——桌面 harness 内嵌控制服务 + 开源哑中继（dumb relay）+ 手机端 PWA，二维码配对，X25519 密钥交换 + NaCl box 加密。**E2E 加密的要求完全可以满足**：中继服务器只转发密文 blob，开发者运维的社区 relay 也看不见任何明文，用户还可以一键切换到自托管 relay 或 Tailscale 直连（此时开发者完全不在链路里）。
2. **移动端形态**：**不建议微信小程序，首选 PWA/H5**。个人主体小程序存在三个硬伤：类目表里没有"远程控制/设备管理"（只能挂靠"工具-办公"，有被驳回风险）；UI 中展示 AI 生成内容会触发"深度合成"类目要求（个人主体无法申请）；小程序网络层强制 wss + ICP 备案域名白名单，无法直连用户电脑，反而把架构逼回"必须经过中继"。PWA 路线下开发者零备案、零服务器合规负担（代码开源分发本身不构成互联网信息服务）。
3. **代码侧改动很小**：harness 的控制面已高度收敛在 Main 进程（`AgentBridge` / `Scheduler` / `SessionRegistry` / `SettingsStore` 四个单例），远程服务只需新增一个 `src/main/remote/` 模块复用这些单例，**现有代码几乎零改动**，定时任务触发链路、权限裁决链路、中断/续输语义全部天然兼容。
4. **唯一需要如实告知用户的点**：要做到"任何网络环境下 100% 可达"，物理上必须存在一个公网中继（家庭 NAT 后的电脑无法被手机直连）。通过应用层 E2E 加密，这个中继是零知识的——但仍建议随功能附一份简短的《远程功能隐私说明》（草案见附录 B），明确"relay 只能看到密文与连接元数据，看不到代码、提示词与会话内容"。这不是 Claude Code / ZCode 那种"明文上传"，性质完全不同，但坦诚说明对建立信任至关重要。

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

**结论**：真正做到「E2E + 数据不过开发者 + 全开源」三者兼备的公认范式就是 Happy 的三段式（本机控制端 + 哑 relay + 移动客户端，"keep the server dumb"）。大厂官方方案全部是"账号绑定 + 厂商可见明文"，不符合本项目要求。

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
| 微信小程序 | 后台约 5 分钟断连；最多 5 个并发 WS | 个人主体仅一次性订阅消息（授权一次推一条） | **不适合长连接仪表盘场景** |
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

设计原则（照 Happy 的"keep the server dumb"）：**relay 只做三件事——按公钥哈希路由加密 blob、当离线消息队列、（可选）托管 PWA 静态文件；所有业务逻辑在两端**。

### 4.2 配对与加密协议

1. **配对（二维码带外交换公钥）**：
   - 桌面端首次启用远程功能时生成长期设备密钥对（X25519），私钥存 `~/.spcode/remote/device.key`（0600 权限；可选存系统 keychain）。
   - 桌面 UI 显示 QR：`spcode-remote://pair?v=1&relay=<url>&desktop_pk=<base64>&otp=<8位一次性码>`。
   - 手机 PWA 扫码 → 生成自己的设备密钥对 → 通过 relay 向 `desktop_pk` 对应 channel 发送用 `otp` 派生密钥加密的握手消息（含手机公钥）→ 桌面端解密成功即完成双向认证，双方落盘对方公钥。
   - OTP 防中间人：即使 relay 作恶也无法伪造（不知道带外的 otp）。桌面端显示设备指纹（双方公钥哈希前 8 位）供人工核对，类似 SSH fingerprint。
2. **会话加密**：
   - 每条消息：NaCl box（X25519 ECDH + XSalsa20-Poly1305）或 XChaCha20-Poly1305；每次 App 启动协商 ephemeral 会话密钥做前向保密；消息带单调递增 `seq` 防重放。
   - 移动端私钥存 IndexedDB（PWA 无 keychain，标记为已知弱点；原生 App 阶段换 SecureStore）。
3. **离线队列**：relay 按 channel 存加密 blob（带 TTL，如 72h），手机离线期间桌面端的 `permission.request`、定时任务完成通知等先入队，手机上线后补拉解密。天然支持"异步批准"。
4. **多设备**：一个桌面端可配多台手机（device 列表管理，可逐个吊销）；每条消息向所有已配对设备各加密一份。

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
├── crypto.ts           # tweetnacl 封装：box 加解密、ephemeral 会话密钥、seq 防重放
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

极简单进程服务（Node/Bun + `ws`，目标 < 500 行）：

- `GET /health`、`GET /`（可选：托管 PWA 静态构建产物）；
- `wss://<relay>/channel/<pkHash>`：双向转发，消息 envelope `{id, seq, t:"encrypted", c:"<base64>"}`；
- 离线队列：每 channel 最多缓存 N 条（如 1000 条 / 72h TTL），对方上线后按序补投；
- **零持久化明文、零账号体系**——channel 标识就是公钥哈希；
- 配置：`PORT`、队列上限、TTL；单文件 Docker 镜像 + `docker run` 一键自托管；
- 官方托管一个免费社区 relay（域名如 `relay.spcode.dev`），并在 README 显著位置写明"relay 只见密文，欢迎自托管"。

### 4.6 手机端 PWA 实现

- 技术栈：Vite + React + Tailwind（复用 packages/shared 的类型），构建为纯静态文件。源码放 `apps/mobile/`（monorepo 新 package）。
- 分发方式（三层，由简到繁）：
  1. **局域网**：`http://<电脑局域网IP>:<port>`（harness 内嵌静态服务 + mDNS），同 Wi-Fi 零配置；
  2. **relay 托管**：`https://relay.spcode.dev/app/` 打开 PWA，扫码配对后走加密通道；
  3. **用户自托管 relay**：同上，relay 地址在配对 QR 里携带。
- 核心界面（一期）：会话列表（状态徽章）→ 会话详情（输出流 + 输入框 + 中断按钮 + todo 进度）；权限批准卡（全屏强提醒）；定时任务列表/新建/启停；配对与设备管理。
- iOS 限制如实告知：PWA 须"添加到主屏幕"才有 Web Push；后台被杀后靠推送唤醒 + 打开时补拉离线队列。

### 4.7 通知推送

- 一期：PWA Web Push（VAPID；推送 payload 只放"会话 X 需要批准"这类无内容提醒，不含任务数据——Apple/Google 推送通道只见元数据）。
- 桌面端作为 VAPID 应用服务器直接发推送（经 relay 转发加密后的 push 指令），无需开发者持有推送服务。
- 可选兜底：Telegram Bot / Bark（iOS）/ 企业微信 webhook，用户自填凭据——完全用户自控，开发者不沾数据。

---

## 5. 隐私边界声明（重要，需如实写进 README）

| 组件 | 能看到什么 |
|---|---|
| 配对的两台设备（手机 + 电脑） | **全部明文**（这是 E2E 的两端） |
| 社区/自托管 relay | 密文 blob、channel 标识（公钥哈希）、连接时间与流量元数据；**看不到**代码、提示词、会话内容、定时任务内容 |
| 推送通道（Apple/Google/Bark 等） | 无内容提醒（"有权限请求待处理"）；不含任务数据 |
| 开发者（我们） | 若用户用官方社区 relay：同上，只有元数据；若用户自托管 relay 或 Tailscale：**完全不在链路里** |
| 模型 API 厂商 | 与现状一致（用户自己的 Key 直连厂商，与远程功能无关） |

结论：**"数据不经过我们服务器"的要求在架构上成立**（E2E + relay 零知识 + 可自托管），不需要 Claude Code 式的大规模数据收集隐私协议。但出于坦诚与合规审慎，仍随功能附一份一页纸《远程功能隐私说明》（附录 B 草案），把上表原样告诉用户。

---

## 6. 分期实施计划

### M1：局域网版（1–1.5 周）—— 验证控制面，零合规风险
- [ ] `remote/` 模块骨架 + Transport 接口 + `lan` 实现（http 静态服务 + ws + mDNS）
- [ ] 配对 v1（局域网内 QR + OTP，X25519 + NaCl box 全套加密先上，协议不返工）
- [ ] RemoteCommand 全量 handler（会话 CRUD/prompt/abort、scheduler CRUD、permission/question reply）
- [ ] 事件聚合器 + 手机端 PWA 最小可用版（会话列表、输出流、输入、批准卡）
- [ ] 设置页"远程控制"分区（开关、QR、设备列表）
- [ ] 单测：crypto 往返、aggregator 节流、handlers 对 bridge 的调用契约；e2e：模拟 WS 客户端跑通"建会话→prompt→abort→再 prompt"全链路

### M2：relay 版（1.5–2 周）—— 公网可达
- [ ] relay 服务（路由 + 离线队列 + TTL）+ Dockerfile + 自托管文档
- [ ] `transport/relay.ts`：出站 wss、自动重连、离线补拉
- [ ] 配对 QR 携带 relay 地址；relay 托管 PWA 静态资源
- [ ] Web Push（VAPID，无内容 payload）
- [ ] 官方社区 relay 上线（README 显著位置写隐私边界表 + 自托管指引）

### M3：加固与体验（1–2 周，可与 M2 并行排期）
- [ ] 传输层可插拔收尾：`tailscale.ts`（检测 tailscaled + 引导 `tailscale serve`）
- [ ] 定时任务移动端完整管理 UI（含 runNow）
- [ ] 权限批准双端同步撤销（一端回答后另一端卡片消失）
- [ ] 设备管理（多手机、吊销、设备指纹核对 UI）
- [ ] 安全审计自查清单：私钥 0600、OTP 单次有效、seq 防重放、relay 不记明文日志、依赖审计（tweetnacl 锁定版本）
- [ ] 《远程功能隐私说明》随应用内置 + README 链接

### 远期（不在本期承诺）
- 原生 App（Expo，参考 Happy）、WebRTC P2P 直连加速层、微信小程序（届时建议个体工商户主体）

---

## 7. 风险与开放问题

| # | 问题 | 现状与建议 |
|---|---|---|
| 1 | 官方社区 relay 的运营成本与滥用 | 流量极小（加密控制信令 + 聚合后的文本），单台小 VPS 可支撑早期；滥用防护：按 channel 限流、队列配额。需决策：是否一期就托管官方 relay，还是 M1/M2 先纯自托管 |
| 2 | iOS PWA 体验天花板 | 后台必死，推送需安装到主屏幕。如实写入文档；重度用户引导用 Bark/Telegram 兜底通知 |
| 3 | 手机端私钥存 IndexedDB | PWA 无安全 enclave，XSS 即丢钥。缓解：PWA 仅 relay/局域网自有源分发、严格 CSP、设备吊销机制 |
| 4 | 权限 10 分钟超时 | 手机没看到推送就自动拒绝。一期保持现状，后续做成可配置 + 超时前桌面本地兜底逻辑不变 |
| 5 | relay 元数据 | 连接时间/流量模式理论上可侧写"何时在编程"。自托管 relay 彻底消除；README 如实说明 |
| 6 | 小程序路线是否彻底放弃 | 本期放弃；若未来做，先注册个体工商户再评估类目 |

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

## 附录 B：《远程功能隐私说明》草案（随功能内置）

> **远程控制功能隐私说明**
>
> 1. 远程功能默认关闭，由您手动开启并扫码配对后才生效。
> 2. 您的手机与电脑之间的所有通信采用端到端加密（X25519 密钥交换 + XSalsa20-Poly1305）。加密密钥仅存储在您的两台设备上，配对通过本机展示的二维码带外完成。
> 3. 为使手机在任意网络下可达您的电脑，消息会经过一台中继服务器（relay）。中继服务器只存储和转发**加密后的数据**，无法读取其中的代码、提示词、会话内容或定时任务内容。中继服务器可见的信息仅限于：连接时间、数据量等元数据。
> 4. 您可以在设置中将中继服务器替换为自行部署的实例（开源，一键部署），或通过 Tailscale 直连；此时您的数据完全不经过我们运营或关联的任何服务器。
> 5. 任务通知推送（如"有权限请求待批准"）通过系统推送通道送达，推送内容不含任何任务数据。
> 6. 本功能全部代码（桌面端、中继、手机端）开源，欢迎审计：<仓库地址>。
> 7. 我们不出售、不分析、不训练您的任何数据——架构上我们也做不到。
