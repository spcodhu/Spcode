# 命令沙盒（Sandbox）

Spcode 的 bash/powershell 工具命令在 OS 级沙盒内执行，由内核强制边界，
不依赖正则黑名单的自觉。实现基于 [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime)
（与 Claude Code 内置沙盒同源），与既有审批网关互补：

| 层 | 管什么 |
|---|---|
| 沙盒（内核强制） | 文件写入边界、敏感路径禁读、网络域名白名单 |
| 审批网关（应用层） | 危险命令（rm -rf、sudo…）与对外动作（git push、发布…）始终弹窗 |

## 平台支持

| 平台 | 机制 | 依赖 |
|---|---|---|
| macOS | Seatbelt（`sandbox-exec`） | 无（系统自带） |
| Linux | bubblewrap + socat（网络代理解析） | `apt/dnf install bubblewrap socat ripgrep` |
| Windows | 暂不支持（上游 srt-win 仍为 alpha） | — 自动降级为纯审批网关 |

沙盒不可用（缺依赖/平台不支持/初始化失败）时，会话状态 chip 显示「无沙盒」，
网关退回「每条写类命令都弹窗」的行为。fail-closed 原则：沙盒包装失败的命令
不会被执行（绝不静默裸跑）；要跑无沙盒命令只能在设置里关闭沙盒。

## 默认边界

**文件写入（allow-only）**：会话工作目录、系统临时目录、开发工具缓存
（npm/pnpm store/yarn/bun/pip/cargo registry/go pkg/maven/gradle）。
缓存刻意精确到 store 子目录，不含任何 bin 目录——否则沙盒内可向 PATH 上的
可执行文件投毒，等用户在沙盒外执行时逃逸。

**禁止读取**：`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.netrc`、`~/.config/gh`、
`~/.spcode/agent/auth.json`（模型供应商密钥）。

**禁止写入**（在可写区域内 further 收紧）：`~/.spcode` 的记忆与配置项
（SOUL.md / USER.md / MEMORY.md / sessions.json / settings.json / agent/ /
plans/ / projects/ 等精确枚举）、项目内 `.env*`。

> 为什么是精确枚举而不是整目录禁写 `~/.spcode`：聊天模式的工作目录是
> `~/.spcode/scratch`，整目录 deny 会把会话自己的 cwd 锁死。

**网络（allow-only）**：GitHub 系、npm/yarn/pnpm、PyPI、crates、Go proxy、
Maven/Gradle。白名单外域名首次访问会弹窗询问；同意后本次运行内有效，
永久放行请到 设置 → 沙盒 → 网络白名单 添加。

## 已知取舍

- **SSH 协议的 git 远程在沙盒内不可用**（`git@github.com:…` 走 22 端口直连，
  不经过 HTTP/SOCKS 代理）。远程仓库请使用 HTTPS。
- **edit/write 文件工具不在沙盒内**（与 Claude Code 一致）——它们由审批网关约束。
  沙盒只包 shell 命令及其子进程树。
- 沙盒不做 CPU/内存限额；fork 炸弹这类资源耗尽靠网关的 danger 规则拦。

## 架构

```
模型 bash 调用
  → 权限网关（readonly 放行 / write 看沙盒 / outward、danger 弹窗）
  → 沙盒化 bash 工具（同名 customTool 覆盖 pi 内置 bash）
  → SandboxManager.wrapWithSandbox(command, customConfig=会话级文件系统边界)
  → pi 原生本地执行后端（流式输出/截断/进程树终止不变）
```

- 注入点：pi 工具注册表中同名 customTool 覆盖内置工具；执行后端经
  `BashOperations` 插拔，保留内置工具全部行为。
- `SandboxManager` 是 agent-host 进程级单例（网络代理由它常驻）；文件系统边界
  随每条命令以 per-command customConfig 下发（字段级覆盖，网络段不动）。
- 违规归因：wrap 时下发 commandId，seatbelt/seccomp/代理的拦截记录执行完后
  取回、附在工具输出尾部喂给模型——模型能看懂「被沙盒拦了」并如实转告用户，
  而不是盲目重试。

## 测试

- `test/sandbox-exec.test.ts`：内核级行为断言（不信任验证——断言 OS 的
  EPERM/403，而非库的宣称）。macOS 真跑，Linux 按依赖 skip。
- `test/sandbox-manager.test.ts`：封装层状态机 + 网络审批回调全链路。
- `e2e/smoke.spec.ts`：设置页沙盒区块（临时 SPCODE_HOME 隔离）。

## 供应链与升级纪律

- 版本 pin 死在 `apps/desktop/package.json`（0.0.79），升级前必读上游
  changelog 与 diff，并关注其 GitHub Security Advisories。
- 该库纯本地运行，无任何遥测/回传（已审计 dist 网络面）。
- 所有对库的调用收敛在 `src/agent-host/sandbox/` 一个目录内，
  未来替换实现（nono/自研）不影响其他模块。
