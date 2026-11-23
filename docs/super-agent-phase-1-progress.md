# Super Agent 阶段一实施进度

> 更新时间：2026-11-23。本文只记录已经落地并有测试证据的能力，不把规划中的 Worker、外部 Source 或副作用执行写成已完成。

## 当前里程碑：统一工作台 + 本地权威控制面

功能分支：`feature/super-agent-phase-1`。

### 已落地

- 新增普通 Node 进程 `apps/control-plane`，不导入 Electron，默认只监听 `127.0.0.1:47831`。
- 新增 `apps/workbench`，直接构建现有 `apps/desktop/src/renderer`；Electron 与 Chromium 使用同一 React 源码和同一静态构建，没有复制页面。
- Electron 的 `local-service.ts` 只负责服务发现、拉起、健康检查和旧 IPC 传输适配。关闭 Electron 只断开桌面适配器，不停止控制面。
- 新增 `@spcode/superagent` 纯领域包，以及 `@spcode/shared/superagent`、`@spcode/shared/control-client` 版本化 wire / Client SDK。
- `~/.spcode/superagent/control.sqlite` 使用 WAL、外键、busy timeout 和 schema 版本；已建立 SourceEvent、Digest、Trigger、Thread、WorkItem、Plan、Approval、Run/Attempt、Mailbox、Lease/Fence、Effect、Outbox、Artifact 与审计表。
- 本地 Web Trigger 支持幂等创建；计划修订使旧 `planHash` 失效；批准在事务内写 Approval、Run、Mailbox、状态与审计，重复批准不会创建第二个 Run。
- SuperAgent 页面已接入共享侧栏，支持本地工作项创建、计划提交、批准、暂停派工和停止。待人工处理、运行/队列、桌面连接和派工状态来自同一权威快照。
- 浏览器和 Electron 通过 HTTP 命令与 WSS 变化提示同步；WSS 不代替快照，客户端收到提示后重新拉取事实。
- 旧会话命令仍由桌面主进程执行。浏览器通过认证后的桌面适配器调用同一 `executeHostCommand`，没有在 Web 端另写注册表、权限或 Session 生命周期。

### 本地 Web 安全

- 控制面只绑定 loopback；Host、Origin、自定义客户端头和 SameSite=Strict Cookie 共同构成浏览器边界。
- 启动链接把 `device-token` 放在 URL fragment；工作台用它换取 HttpOnly Cookie 后立即从地址栏和历史记录移除。
- Cookie 原文不写入 SQLite，数据库只保存 SHA-256 哈希；认证会话可在控制面重启后恢复。
- `device-token` 与 `runtime.json` 都是 0600；桌面适配器使用独立的 `serviceToken`，不会下发给浏览器。
- 静态页面公开不等于 API 公开；未认证快照、命令、桌面代理和 WSS 全部失败关闭。

## 启动与使用

### 从 Electron 启动

```bash
pnpm dev
```

Electron 会先构建 Workbench 与控制面，再发现或拉起本地服务。点击侧栏 **Super Agent**，再点击 **在浏览器打开** 即可在系统浏览器中看到同一工作台。

### 只运行 headless 控制面

```bash
pnpm --filter @spcode/workbench build
pnpm --filter @spcode/control-plane build
pnpm --filter @spcode/control-plane start
```

终端会打印带设备引导 fragment 的本地 URL。该完整 URL 含本地凭据，不应发到 Issue、聊天或公开日志。可用 `SPCODE_CONTROL_PORT=0` 选择随机空闲端口；测试必须使用临时 `SPCODE_HOME`。

数据与诊断位置：

```text
~/.spcode/superagent/control.sqlite
~/.spcode/superagent/runtime.json
~/.spcode/superagent/device-token
~/.spcode/superagent/control-plane.log
```

只有显式停止该 Node 进程才进入控制面关闭流程；关闭 Electron 不会停止它。电脑关机、睡眠或系统未运行服务时不持续在线。

## 已有验证

- 领域与 SQLite 单测：状态机、Source Gate、Trigger 幂等、计划修订、重复批准、取消、WAL/外键/schema 版本和重启恢复。
- HTTP/WSS 集成：匿名 API、恶意 Host/Origin、CSRF、静态资源、认证重启恢复、桌面命令代理、变化事件和令牌文件权限。
- Chromium E2E：真实创建 → 计划 → 批准 → 持久化队列 → 刷新恢复。
- Electron + Chromium E2E：Electron 创建工作项后退出，控制面仍健康，浏览器重新打开看到同一 WorkItem。

运行方式：

```bash
pnpm --filter @spcode/control-plane test
pnpm --filter @spcode/workbench build
pnpm --filter @spcode/workbench test:e2e
pnpm --filter @spcode/desktop build
pnpm --filter @spcode/desktop test:e2e --grep "Electron 与浏览器共享"
```

## 明确未完成

当前页面中的 **已排队** 只表示 Approval、Run 与 Mailbox 已持久化，不表示代码已修改或已提交。以下仍属于后续阶段一工作包：

1. GitHub Connector、增量游标、DigestScheduler、FakeGitHub 与飞书群 / 卡片持久化。
2. 传输无关 `@spcode/agent-runtime` 抽取，以及模型自动产生只读计划。
3. 独立 Node Worker、每 WorkItem worktree、有界并发、ReportWork、受控本地 commit 和崩溃恢复。
4. Effect Executor / Provider、Artifact Store、完整 UNKNOWN 对账。
5. 独立 Watchdog、完整服务设置、故障注入矩阵和 Windows 实测。

因此当前提交是阶段一的可运行基础里程碑，**不是阶段一退出条件已经达成**。
