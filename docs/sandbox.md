# 命令沙盒（Sandbox）

Spcode 的 bash/powershell 工具命令在 OS 级沙盒内执行，由内核强制边界，
不依赖正则黑名单的自觉。实现基于 [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime)
（与 Claude Code 内置沙盒同源），与既有审批网关互补：

| 层 | 管什么 |
|---|---|
| 沙盒（内核强制） | 文件写入边界、敏感路径禁读、网络域名白名单 |
| 审批网关（应用层） | 危险命令（rm -rf、sudo…）与对外动作（git push、发布…）始终弹窗；免审批规则（「总允许」沉淀）只对 write/outward 生效，danger 永远弹窗 |

## 平台支持

| 平台 | 机制 | 依赖 |
|---|---|---|
| macOS | Seatbelt（`sandbox-exec`） | 无（系统自带） |
| Linux | bubblewrap + socat（网络代理解析） | `apt/dnf install bubblewrap socat ripgrep` |
| Windows | 暂不支持（上游 srt-win 仍为 alpha） | — 自动降级为纯审批网关 |

沙盒不可用（缺依赖/平台不支持/初始化失败）时，网关退回「每条写类命令都弹窗」的行为。
fail-closed 原则：沙盒包装失败的命令不会被执行（绝不静默裸跑）；
唯一合法的无沙盒路径是逃生舱（见下）或设置页关闭沙盒。

## 设置页开关的真实语义

「启用命令沙盒」不是偏好开关，而是决定**会话创建时**是否用沙盒版 bash 覆盖内置 bash：

| 开关 | 工具集 | 审批 | 网络白名单 |
|---|---|---|---|
| 开 | 沙盒版 bash（内核边界） | `autoAllow` 开时沙盒内 write 免弹窗；danger/outward 仍弹 | 生效 |
| 关 | pi 内置 bash（进程权限直跑） | 每条 write/outward 都弹窗（`autoAllow` 失效） | 不生效 |

- 工具集在会话创建时固定，**改动只对新会话生效**（已打开会话沿用创建时的工具集）。
- `read`/`write`/`edit` 由进程内路径守卫（`fs-guard`）约束，与本开关无关。
- 设置页顶部状态条经宿主 `sandbox.status` 实时查询（会先 `configure` 主进程下发的设置再
  `ensureReady`，避免无会话时误报 disabled），显示生效机制或不可用原因；
  `unavailable` 的 `reason`（如 Linux 缺 bwrap/socat/rg）不再被吞掉。

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

**本地端口**：默认允许沙盒内命令监听 localhost（dev server、playwright 等
开发场景需要）；可在 设置 → 沙盒 → 允许监听本地端口 关闭。

## 逃生舱（沙盒外重试）

对齐 Claude Code 的 `dangerouslyDisableSandbox`：有些命令与沙盒**根本冲突**
——启动 GUI/Electron 应用（Mach 服务查询被 Seatbelt 禁止，e2e 就是这类）、
访问 macOS 钥匙串（git HTTPS 推送的凭据助手）、Docker 守护进程 socket 等。
这类命令在沙盒内注定失败，盲目重试没有意义。

流程：

1. 命令在沙盒内执行失败，违规归因（内核/代理拦截记录）附在工具输出尾部，
   并提示模型「可用 `dangerouslyDisableSandbox=true` 重试」；
2. 模型带该参数重试 → **强制弹窗**（不享受 autoAllow 免审批），卡片以
   「沙盒外」红色徽标强警示：命令将以完整权限运行，不受文件/网络边界约束；
3. 用户批准后，命令由独立的纯本地执行路径运行（不经 wrap、不写违规归因）。

设置 → 沙盒 →「允许沙盒外重试」可关闭逃生舱（严格模式）：此时网关直接拒绝
带 bypass 参数的请求，模型会收到明确说明。

**子代理（Task 工具）没有逃生舱**：子会话不挂权限网关，沙盒是其唯一防线，
注册的 bash 工具 schema 里根本没有该参数——开了就是无审批逃逸口。

## 沙盒外白名单（excludedCommands）与免审批规则（permissionRules）

两类用户可控的「放松」，都在设置页可视可删：

- **沙盒外命令白名单**（设置 → 沙盒）：前缀匹配（如 `git push`、`pnpm test:e2e`），
  命中的命令固定不经沙盒直接执行，但仍走普通权限审批（不享受 autoAllow）。
- **免审批规则**（设置 → 通用 → 权限模式）：权限卡点「总允许」沉淀的命令前缀，
  命中的 write/outward 级 shell 命令免弹窗；**danger 级永远不免**，
  网络域名询问不参与规则匹配。

权限卡「总允许」作用于逃生舱请求时会**双写**两条：以后该前缀的命令直接
沙盒外执行且不再询问。等于把这条命令完全交给用户自己背书——请只对你
充分信任的命令使用。

## 已知取舍

- **SSH 协议的 git 远程在沙盒内不可用**（`git@github.com:…` 走 22 端口直连，
  不经过 HTTP/SOCKS 代理）；HTTPS 推送需要钥匙串，沙盒内同样不可用。
  推送/发布类命令的现实路径：逃生舱重试（可「总允许」一次到位）。
- **edit/write 文件工具不在沙盒内**（与 Claude Code 一致）——它们由审批网关约束。
  沙盒只包 shell 命令及其子进程树。
- 沙盒不做 CPU/内存限额；fork 炸弹这类资源耗尽靠网关的 danger 规则拦。

## 架构

```
模型 bash 调用
  → 权限网关（readonly 放行 / 沙盒内 write 免审批 / outward、danger、bypass 弹窗 / 免审批规则放行）
  → 沙盒化 bash 工具（同名 customTool 覆盖 pi 内置 bash）
     ├─ dangerouslyDisableSandbox=true → 独立纯本地定义执行（网关已批）
     ├─ excludedCommands 命中 → 跳过 wrap 直接执行
     └─ 默认 → SandboxManager.wrapWithSandbox(command, customConfig=会话级文件系统边界)
  → pi 原生本地执行后端（流式输出/截断/进程树终止不变）
```

- 注入点：pi 工具注册表中同名 customTool 覆盖内置工具；执行后端经
  `BashOperations` 插拔，保留内置工具全部行为。逃生舱用**双 ToolDefinition
  实例**（沙盒路径/本地路径零共享状态），避免并行调用串扰。
- `SandboxManager` 是 agent-host 进程级单例（网络代理由它常驻）；文件系统边界
  随每条命令以 per-command customConfig 下发（字段级覆盖，网络段不动）。
- 违规归因：wrap 时下发 commandId，seatbelt/seccomp/代理的拦截记录执行完后
  取回、附在工具输出尾部喂给模型——模型能看懂「被沙盒拦了」并按提示走逃生舱，
  而不是盲目重试。

## 与 Claude Code / Finch 的设计对应

| 能力 | Claude Code | Finch | Spcode |
|---|---|---|---|
| OS 级沙盒 | sandbox-runtime（同源） | 无（纯权限） | sandbox-runtime |
| 沙盒内免审批 | autoAllowBashIfSandboxed | Act 模式 | autoAllow |
| 逃生舱 | dangerouslyDisableSandbox + allowUnsandboxedCommands | 不适用 | 同名参数 + 同名开关 |
| 固定沙盒外命令 | excludedCommands | 不适用 | excludedCommands |
| 规则沉淀 | allow 规则（settings） | 「总允许」permissionRuleStore | 权限卡「总允许」→ permissionRules |
| 本地端口 | allowLocalBinding | 不适用 | allowLocalBinding（默认开） |

## 测试

- `test/sandbox-exec.test.ts`：内核级行为断言（不信任验证——断言 OS 的
  EPERM/403，而非库的宣称）。macOS 真跑，Linux 按依赖 skip。
- `test/sandbox-manager.test.ts`：封装层状态机 + 网络审批回调全链路 +
  allowLocalBinding 内核级断言（沙盒内真绑端口）。
- `test/sandbox-bypass.test.ts`：逃生舱/白名单的封装层决策（bypass 直跑、
  excluded 直跑、fail-closed 不裸跑、子代理工具无逃生舱参数）。
- `test/permission-decision.test.ts`：裁决纯函数——outward 弹窗回归、
  免审批规则命中/边界、danger 不免、network 询问不参与规则。
- `e2e/smoke.spec.ts`：设置页沙盒区块与新控件（临时 SPCODE_HOME 隔离）。

## 供应链与升级纪律

- 版本 pin 死在 `apps/desktop/package.json`（0.0.79），升级前必读上游
  changelog 与 diff，并关注其 GitHub Security Advisories。
- 该库纯本地运行，无任何遥测/回传（已审计 dist 网络面）。
- 所有对库的调用收敛在 `src/agent-host/sandbox/` 一个目录内，
  未来替换实现（nono/自研）不影响其他模块。
