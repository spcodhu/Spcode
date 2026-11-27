# Super Agent 阶段二使用、测试与环境配置

> 更新时间：2026-11-23。阶段二代码与 Fake/临时基础设施验收已完成。真实公网 OIDC、云 PostgreSQL、真实云 Worker、云 S3/OSS、GitHub/飞书生产凭据和真实模型负载仍需你补环境后联调，不在本文冒充已验收。

## 1. 已实现范围

- 公网 Web：OIDC viewer/operator/admin、Secure Cookie、可信 Host/Origin、TLS 代理、CSRF、限流、Nginx 参考配置；Electron 可选本地或外部 Router。
- 数据层：真实 PostgreSQL Store、SQLite 备份导入、非空目标拒绝、identity 序列恢复、多 Router Source 单活和 WorkItem CAS。
- Worker Node：主动出站 WSS、配对/吊销、能力注册、心跳、拉取、取消、并发背压、独立 worktree、跨节点 RecoveryBundle。
- Effect：独立审批、幂等请求、Executor fence、UNKNOWN 对账；Artifact/Report、Nginx、Deployment、DNS、Git push/PR、受限系统调用。
- Artifact：本地磁盘与 S3/OSS 后端、私有认证下载、可过期/撤销 ShareLink、生命周期清理。
- Thread：CI/review/纯上下文 Mailbox 与人工新需求 PlanRevision 分流，停止不被唤醒。
- 运维台：Worker/Effect/分享状态、失联恢复入口和 Artifact 分享按钮。

## 2. 本地启动控制面

先安装依赖并构建：

```bash
pnpm install
pnpm --filter @spcode/control-plane build
pnpm --filter @spcode/workbench build
pnpm --filter @spcode/worker-node build
pnpm --filter @spcode/effect-executor build
```

本地启动：

```bash
SPCODE_SUPERAGENT_ENABLED=1 pnpm --filter @spcode/control-plane start
```

终端会打印带本地设备引导 fragment 的 URL。打开后完成认证，进入 **Super Agent**。也可以用 `pnpm dev` 启动 Electron，再点击 **Super Agent → 在浏览器打开**。

本地控制面默认仅监听 `127.0.0.1:47831`，数据在 `~/.spcode/superagent/`。关闭 Electron 不停止控制面；停止电脑、睡眠或显式停止服务才离线。

## 3. 公网 Router + OIDC

1. 在 `deploy/nginx/spcode.conf` 替换 `agent.example.com`、证书路径和上游端口，启用 HTTPS。
2. 设置 `SPCODE_PUBLIC_URL=https://agent.example.com`、`SPCODE_TRUSTED_HOSTS`、`SPCODE_TRUSTED_ORIGINS`、`SPCODE_OIDC_ISSUER`、`SPCODE_OIDC_AUDIENCE`、`SPCODE_OIDC_JWKS_URL`。
3. 启动 Router。公网不接受 device-token 配对码代替身份认证；浏览器需通过 OIDC 换取 Secure HttpOnly Cookie。
4. 将 Electron 的 `SPCODE_CONTROL_PLANE_URL` 指向公网 Router。需要时再给本地启动提供一次 `SPCODE_CONTROL_PLANE_BOOTSTRAP_TOKEN`，工作台会换 Cookie 后清理 URL fragment。

角色：

| 角色 | 权限 |
|---|---|
| viewer | 读取工作台、节点、Effect、分享状态 |
| operator | 工作项、审批、Effect 请求/批准/对账、恢复 |
| admin | 额外修改配置、配对/吊销节点、停止服务 |

## 4. 启动 Worker Node

### 本地配对

先读取本地 `~/.spcode/superagent/runtime.json` 的 `serviceToken`（这是敏感凭据，不要发到群或提交到 Git）：

```bash
SPCODE_CONTROL_PLANE_URL=http://127.0.0.1:47831 \
SPCODE_WORKER_PAIR_TOKEN=<runtime.json 中的 serviceToken> \
SPCODE_WORKER_NODE_NAME=worker-local-1 \
SPCODE_WORKER_NODE_DATA_DIR=/tmp/spcode-worker-1 \
SPCODE_WORKER_REPO_PATH=/absolute/path/to/Spcode \
SPCODE_WORKER_NODE_CAPACITY=1 \
SPCODE_SUPERAGENT_FAKE_WORKER=1 \
pnpm --filter @spcode/worker-node start
```

节点第一次启动会写入 `SPCODE_WORKER_NODE_DATA_DIR/node.json`（0600）。之后可以去掉 `SPCODE_WORKER_PAIR_TOKEN`，也可以显式传 `SPCODE_WORKER_NODE_ID` / `SPCODE_WORKER_NODE_TOKEN`。

生产真实 Worker 不设置 `SPCODE_SUPERAGENT_FAKE_WORKER`，使用本地模型 profile。每个节点有自己的 mirror/worktree；控制面只发送已批准计划，GitHub/飞书/云资源凭据不下发。

### 多节点/多 Router

- 每个 Router 设置相同 `SPCODE_POSTGRES_URL`，业务表共享。
- 节点可以连不同 Router，只需各自的 `SPCODE_CONTROL_PLANE_URL`。
- 节点 capacity 默认 1，建议每个节点从 1 开始，按机器资源逐步增加。
- `POST /api/v1/worker-nodes/revoke` 吊销后，旧节点不能继续领取或写入。

## 5. 启动 Effect Executor

Executor 与 Worker token 分离：

```bash
SPCODE_CONTROL_PLANE_URL=http://127.0.0.1:47831 \
SPCODE_EXECUTOR_TOKEN=<另一个受控 token> \
SPCODE_EXECUTOR_ID=effect-executor-1 \
pnpm --filter @spcode/effect-executor start
```

Executor 不运行模型、不接收通用远程 Shell。它只处理已批准的 Effect：

1. operator 创建 EffectRequest（独立 `PENDING_APPROVAL`）。
2. 使用对应 `inputHash` 批准，才进入可领取队列。
3. Executor 竞争 fence 并调用一个 Provider。
4. 成功、失败、UNKNOWN 均写回；UNKNOWN 必须对账，不能自动重放。

Provider 环境：

- Nginx：`SPCODE_NGINX_ROOT` 限制目标配置目录，先 `nginx -t`，非法配置不会 reload。
- Deployment：`SPCODE_DEPLOYMENT_ROOT` 限制 Compose 文件，固定 `docker compose up -d <service>`。
- DNS：`SPCODE_CLOUDFLARE_API_TOKEN`，按 zone/record 查询后 upsert，超时 UNKNOWN。
- Publisher：只允许 `superagent/*` 分支首推或 fast-forward，拒绝 non-fast-forward/force；不自动 merge。
- 系统运维：仅允许白名单可执行文件，不开放通用远程 Shell。

## 6. Artifact 与分享

默认使用本地受管磁盘。配置 `SPCODE_ARTIFACT_S3_*` 后使用 S3/OSS 兼容存储，数据库仍只保存元数据，凭据仅在对象存储 worker 中。

- 私有 Artifact 在 WorkItem 详情中下载。
- 点击 **分享** 创建一次性高熵 ShareLink，当前有效期 1 小时；token 只在创建响应中出现一次。
- 匿名分享是独立发布授权，过期/撤销立即失效；列表不显示 token 原文。
- `prune` 支持按时间清理对象和分享授权。

## 7. SQLite → PostgreSQL 迁移

先构建，再导出（备份文件权限 0600，不含身份 token/会话）：

```bash
SPCODE_MIGRATE_DIRECTION=export \
SPCODE_MIGRATE_FROM_SQLITE=/absolute/path/to/control.sqlite \
SPCODE_MIGRATE_BACKUP=/absolute/path/to/control-backup.json \
node apps/control-plane/scripts/migrate-store.mjs
```

确认目标 PG 没有 WorkItem、Outbox 或 Artifact 记录，再导入：

```bash
SPCODE_MIGRATE_DIRECTION=import \
SPCODE_POSTGRES_URL=postgresql://spcode:change-me@127.0.0.1:5432/spcode \
SPCODE_MIGRATE_BACKUP=/absolute/path/to/control-backup.json \
node apps/control-plane/scripts/migrate-store.mjs
```

非空目标会拒绝导入，防止双写或覆盖。导入事务失败会回滚。恢复包、节点租约、Effect、Outbox、Artifact 引用一起迁移，PG identity 序列会推进。

## 8. 测试命令

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build

# 阶段二真实临时基础设施
pnpm --filter @spcode/control-plane test -- postgres-store.test.ts router-migration.test.ts multi-router.test.ts
pnpm --filter @spcode/control-plane test -- artifact-object.test.ts share-link.test.ts effect-gateway.test.ts
pnpm --filter @spcode/worker-node test
pnpm --filter @spcode/effect-executor test

# 阶段二 2 Router + 3 Worker Node 拓扑
pnpm --filter @spcode/worker-node test -- phase2-e2e.test.ts

# 统一工作台
pnpm --filter @spcode/workbench build && pnpm --filter @spcode/workbench test:e2e
pnpm --filter @spcode/desktop build && pnpm --filter @spcode/desktop test:e2e
```

嵌入式 PostgreSQL 与 s3rver 都是真实临时进程/协议服务，测试结束自动停止清理。Fake Worker 拓扑只用于确定性地验证调度和恢复，不能替代真实模型验收。

## 9. 已验证与待联调

已验证：OIDC 安全、真实 PG 多 Router、3 节点并行与断线恢复、Effect Provider、S3/OSS、ShareLink、连续 Thread、当前仓库 dogfood、统一 Web 工作台。

Fake 拓扑实测示例：p50≈219ms、p95≈244ms（本机一次运行，非性能承诺）。

仍需你补环境后联调：

- 公网正式 OIDC/JWKS、云 PostgreSQL、真实云 Worker Node、云 S3/OSS。
- 真实飞书/GitHub 生产凭据、Publisher 的真实远端和 Cloudflare/DNS/Nginx/Compose 目标。
- 真实模型计划与执行，以及真实 Pi 负载 p50/p95。

环境变量样例见 [super-agent-phase-2.env.example](./super-agent-phase-2.env.example)。真实联调通过前，不把 Fake 结果写成公网生产验收完成。
