# Super Agent 阶段一实施与验收进度

> 更新时间：2026-11-23。阶段一代码工作包已完成。本文区分“已实现的代码能力”“已通过的真实测试”和“仍需用户环境密钥才能做的外部联调”，不把未执行的联调写成完成。

功能分支：`feature/super-agent-phase-1`。

## 1. 已实现的阶段一能力

### A. Headless 控制面与统一 Web 工作台

- `apps/control-plane` 使用普通 Node 进程，不导入 Electron；默认只监听 `127.0.0.1:47831`。
- `apps/workbench` 直接构建现有 `apps/desktop/src/renderer`。Electron 与 Chromium 使用同一 React 源码、同一构建产物和 `@spcode/shared` 协议，没有复制页面。
- Electron `local-service.ts` 仅负责发现、拉起、健康检查与原生适配。关闭 Electron 只断开桌面适配器，不停止控制面或 Worker。
- 版本化 HTTP 命令、WSS 变化提示和统一 Client SDK。WSS 不作为事实源，客户端收到提示后重新拉取 SQLite 权威快照。
- 旧会话能力经认证的桌面适配器渐进迁移；SuperAgent 不依赖桌面 IPC 保存业务事实。
- 统一设置页支持启停、仓库、授权群/人、模型、每日摘要、并发、预算和本地服务。

### B. 领域与 SQLite 持久化

- `@spcode/superagent` 纯领域包、`@spcode/shared/superagent` wire 类型和 `@spcode/shared/control-client` Client SDK。
- `~/.spcode/superagent/control.sqlite` 使用 WAL、外键、busy timeout 和 schema v5 迁移。
- 已覆盖 SourceEvent、Digest、Trigger、Thread、WorkItem、PlanRevision、Approval/Grant、Run/Attempt、Mailbox、Lease/Fence、Effect、Outbox、Artifact、WorkerEvent、WatchdogFinding 与审计。
- 业务状态、审计和事件同事务提交；通知通过确定性 eventId 投影到 Outbox，覆盖落库后/发卡前崩溃。
- 配置与密钥分离：`config.json` 只保存非密钥业务配置，GitHub/飞书密钥仅从环境变量读取。

### C. GitHub 与飞书 Source

- GitHub REST 增量游标、分页、open Issue 过滤、PR 排除、首轮最近 24 小时/50 条限制、contentHash 去重和每日/手动摘要。
- 摘要批准前只有 DigestItem；批准或忽略只作用于当前快照，实质更新可再次进入摘要。
- 飞书授权群/人和结构化 mentions 闸门、eventId 去重、create_time 乱序过滤、群卡片持久化与回调鉴权。
- 真实 Lark 单连接。旧私聊通过桌面 subscriber 复用原 `FeishuChannel` 和权限卡逻辑，不建立第二条长连接。
- Outbox 按 conversation 保序、退避重试、messageId 持久化；超时或重启遗留 SENDING 一律进入 UNKNOWN，不盲目重发，支持人工对账。

### D. Agent Runtime、Worker 与 Git 隔离

- `@spcode/agent-runtime` 同时支持 Electron utilityProcess 和普通 Node IPC，复用 SessionController、工具、权限与沙盒。
- 计划 Worker 只读调研并写 PlanRevision；等待审批时释放物理进程。批准后从 SessionFile 恢复并执行。
- Worker 默认关闭自动标题、记忆蒸馏、全局记忆、Task 和 MCP，不继承桌面免审规则；普通写操作走 auto，outward/danger/沙盒逃逸仍受门禁。
- 每个 Attempt 一个独立 Node 进程，默认全局并发 2、同 WorkItem 并发 1。Worker 事件按 attemptId + seq 去重，旧 fence 的心跳、报告和提交资格全部被拒。
- `ReportWork` 提供结构化状态、测试证据、摘要和建议 commit message；控制面不信任自由文本，独立复跑计划验证命令。
- 每个 WorkItem 使用独立 mirror + worktree + `superagent/<id>` 分支，不 stash、clean、改 HEAD 或提交用户 checkout。Git 写命令只读白名单，commit 只能由 `GitWorkspaceManager` 完成。
- 支持停止、人工 retry、RECOVERING、commit 对账和崩溃恢复；不会重复 Trigger、Approval、Run 或 commit。
- 私有 Artifact Store 保存 Plan、Worker 日志、验证报告和 diff，支持哈希、大小、类型、私有认证下载和 untracked 文件补丁。

### E. 控制台、Watchdog 与生命周期

- 工作台分为工作项、Issue 摘要和本地服务设置。待人工处理置顶，详情展示计划、Attempt、活动、diff、测试、commit、Artifact 和审计。
- 独立 Watchdog 进程通过 serviceToken 调用受限健康接口，默认只生成 Finding，不自动改代码、批准、重启或 push。
- 等待审批、主动停止、长心跳任务和睡眠唤醒不误报；健康正常不制造徽标或群消息。
- 显式停止服务执行：停止新 intake/派工 → 停 Watchdog 和 Source → 安全终止或恢复 Attempt → 处理在途 Outbox → 关闭 WSS/DB/连接 → 移除 runtime。
- 显式停止与崩溃恢复不同：优雅停止移除 runtime 后 Electron 保持停止，不自动拉起。关机、睡眠或系统未运行服务时不持续在线。

## 2. 启动与配置

### 从 Electron 启动

```bash
pnpm dev
```

点击侧栏 **Super Agent**，再点击 **在浏览器打开**，即可在系统浏览器中使用同一工作台。

### 只运行 headless 控制面

```bash
pnpm --filter @spcode/workbench build
pnpm --filter @spcode/control-plane build
pnpm --filter @spcode/control-plane start
```

终端会打印带设备引导 fragment 的本地 URL。该 URL 是本地凭据，不得发到 Issue、群或公开日志。`SPCODE_CONTROL_PORT=0` 可随机选择空闲端口；测试必须使用临时 `SPCODE_HOME`。

环境变量样例见 [super-agent-phase-1.env.example](./super-agent-phase-1.env.example)。密钥后补即可，不需要写入 `config.json` 或代码：

- `SPCODE_GITHUB_TOKEN`
- `SPCODE_FEISHU_APP_ID`
- `SPCODE_FEISHU_APP_SECRET`
- `SPCODE_FEISHU_BOT_OPEN_ID`
- `SPCODE_SUPERAGENT_REPO_PATH` / `SPCODE_SUPERAGENT_REPOS`
- `SPCODE_SUPERAGENT_ALLOWED_CHATS` / `SPCODE_SUPERAGENT_AUTHORIZED_OPERATORS`
- `SPCODE_SUPERAGENT_DIGEST_CHAT_ID` / `SPCODE_SUPERAGENT_DIGEST_REPOS`
- 可选 `HTTPS_PROXY`

数据与诊断位置：

```text
~/.spcode/superagent/control.sqlite
~/.spcode/superagent/config.json
~/.spcode/superagent/runtime.json
~/.spcode/superagent/device-token
~/.spcode/superagent/control-plane.log
~/.spcode/superagent/artifact-content/
```

## 3. 已通过的测试证据

- 领域、SQLite、Git、Worker、Source、Artifact、Watchdog 和配置测试，包含真实 Git 临时仓库与独立 Node 子进程。
- Issue 完整链：临时 Issue → 摘要卡 → 授权按钮 → 只读计划 → 群批准 → worktree 修改 → 验证 → 本地 commit → 群结果。
- 群 @ 完整链：授权人 @ → 只创建一个 WorkItem → 计划 → 批准 → commit；重复投递、双人批准和重启后点卡保持幂等。
- 两个 WorkItem 在不同 worktree 真正并行，用户脏 checkout 的 HEAD/status 不变。
- 真实 SIGKILL 故障注入：批准落库后/派工前、commit 后/回执前，恢复只执行一次。
- 摘要发卡前、计划发卡前和 Outbox 发送后/回执前，恢复不丢事实、不重复外部动作。
- 计划等待跨重启恢复；旧 planHash、非授权群/人、伪造卡、非认证 Web、恶意 Host/Origin/CSRF 全部失败关闭。
- 独立 Watchdog 实测生成 stale Finding；长心跳、暂停、等待审批和睡眠不误报。
- Chromium：自动 Worker、Artifact 下载、Issue 摘要与设置持久化端到端通过。
- Electron + Chromium：批准计划后关闭 Electron，独立 Worker 继续完成 commit，浏览器看到完成结果。
- 当前 monorepo dogfood：完整闭环后用户 HEAD、当前分支和 `git status --porcelain` 完全不变。
- macOS 保留真实 Seatbelt/EPERM 断言；Windows 明确仅有进程/目录隔离，返回 unavailable，不宣称 OS 沙盒。

常用验证命令：

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm --filter @spcode/control-plane test
pnpm --filter @spcode/control-plane test -- dogfood.test.ts
pnpm --filter @spcode/control-plane test -- fault-injection.test.ts
pnpm --filter @spcode/workbench build && pnpm --filter @spcode/workbench test:e2e
pnpm --filter @spcode/desktop build && pnpm --filter @spcode/desktop test:e2e
```

## 4. 尚需环境密钥的外部联调

以下代码路径已实现，但当前没有使用真实用户凭据执行，因此不把它们写成已验收：

- 真实 GitHub 私有仓库与飞书应用的长连接、发卡、群 @ 和卡片回调。
- 真实模型供应商的只读计划、代码修改和测试。无模型启动/退出已验证；完整业务链使用独立 Fake Node Worker，但 Git、验证、commit、恢复和 UI 都是真实实现。
- Windows 实机验证。当前只有平台语义与进程隔离测试；macOS 真沙盒已验证。

补齐环境变量后，应按第 11.3 节的三条链路再做一次真实联调。真实联调通过前，阶段一应视为“代码与 Fake 验收完成，外部联调待确认”，不要宣称外部生产验收已经完成。

## 5. 阶段二未实现（明确不在本次范围）

- 公网远程访问、PostgreSQL、多 Router、远程 Worker Node 和跨节点 RecoveryBundle。
- push/PR Publisher、Nginx/Deployment/DNS Provider、云端 Effect Executor 和匿名 ShareLink。
- 多实例故障切换、Artifact S3/OSS、正式 Linux 常驻服务承诺。
