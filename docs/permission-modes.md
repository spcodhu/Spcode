# 权限模式（三档）设计

> 目标：把输入框那个「行动/询问」按钮升级成现代 Agent 工具的通用三档
> （总是询问 / 必要时询问 / 总不询问），并且与命令沙盒、逃生舱真正接通。
> 调研参考 Codex 的 approval policy × sandbox mode、Claude Code 的
> default/acceptEdits/bypassPermissions 与 allowUnsandboxedCommands。

## 0. 为什么要改（改前的病灶）

改前有两个互不相干的开关、两个裁决点：

| 层 | 位置 | 管什么 | 用户能否看见 |
|---|---|---|---|
| 宿主 | `agent-host/permission-gate.ts` | `sandbox.autoAllow` 为真时，沙盒内 write **直接放行，连权限请求都不发** | 看不到 |
| 主进程 | `main/agent-bridge.ts` | `permissionMode` ∈ {ask, act}：danger/outward 恒问，write 在 act 放行 | 就是那个按钮 |

后果：

1. `sandbox.autoAllow` 默认 `true`，所以**按钮显示「询问」时，沙盒内写命令其实早已静默放行** ——
   按钮的承诺与实际行为不符。
2. 同一个「行动」档在沙盒开/关两种状态下含义不同（开=免问，关=每条都问）。
3. 2×2 组合出四种实际行为，任何一处界面都推不出「下一步会不会弹窗」。

## 1. 一条分工原则

> **权限模式决定「问不问」（应用层），沙盒决定「拦不拦」（内核层），逃生舱是唯一同时改变两者的动作。**

所以 `decidePermissionMatrix` 的入参里**没有 sandboxed**：沙盒状态不改变"要不要问"，
只改变"被拦住时的表现"（EPERM/403 而不是弹窗）。

## 2. 矩阵（唯一事实源：`packages/shared/src/permission.ts`）

| 场景 | 总是询问 `ask` | 必要时询问 `auto` | 总不询问 `never` |
|---|---|---|---|
| readonly 工具 / 只读命令 | 放行 | 放行 | 放行 |
| write（沙盒内、沙盒外、`excludedCommands` 命中一视同仁） | 问 | 放行 | 放行 |
| outward（git push、publish、ssh、`gh release create`…） | 问 | 问 | 放行 |
| danger（rm -rf、sudo、force push…） | 问 | 问 | 放行 |
| 网络白名单外域名（沙盒代理询问） | 问 | 问 | 静默放行 + 审计日志 |
| 逃生舱 `dangerouslyDisableSandbox=true` | 问 | 问 | **问**（唯一保留的人工确认点） |
| 免审批规则命中（`permissionRules`） | 放行 | 放行 | 放行（无意义但无害） |
| 逃生舱被设置关闭（`allowUnsandboxedCommands=false`） | 硬拒 | 硬拒 | 硬拒 |
| fs-guard `deny`（`~/.ssh`、`~/.aws`、`auth.json`…） | 硬拒 | 硬拒 | 硬拒 |
| fs-guard `prompt`（写 `~/.spcode`、写工作区外） | 问 | 问 | 放行 |
| 计划模式门禁（bash 只读白名单、写工具不挂载） | 硬拒 | 硬拒 | 硬拒 |

三条从矩阵读出来的结论，UI 与文档都要照此表述：

1. **「总不询问」不等于没有边界**：沙盒仍然拦、凭据路径仍硬拒、计划模式仍生效，只是不弹窗。
2. **「总不询问」里逃生舱仍然会问**：放行其他一切之后，这是唯一还留在人手上的闸门。
3. **「必要时询问」+ 沙盒关闭 = 写操作免问**：沿用旧 `act` 的语义（用户选择），
   这是相对旧宿主层行为的一处**放宽**，靠界面警示条 + 文档兜，而不是靠用户记忆。

## 3. 裁决链

```
pi beforeToolCall
  → 宿主 permission-gate
      ├─ 计划模式门禁（硬拒）
      ├─ fs-guard deny（硬拒）/ prompt（按 danger 风险参与矩阵）
      └─ decidePermissionMatrix({ risk, mode, bypass, bypassDisabled })
           ├─ block → 直接返回拦截（带可本地化 reason）
           ├─ allow → 放行，不发任何 IPC
           └─ ask   → requestPermission（带 sandboxed / bypass 标记）
  → 主进程 AgentBridge.adjudicate
      ├─ 免审批规则命中（仅 bash/powershell 的 write/outward）→ 直接批准
      ├─ danger / 逃生舱永不被规则自动放行（纵深防御）
      └─ 否则广播：桌面批准卡 / 飞书卡片
```

- 模式按会话存在宿主（`SessionController.permissionModeRef`），运行中切换立即生效。
- 主进程**不再读 `permissionMode`**：它拿不到会话级模式，只保留规则与 UI 传输职责。
- 网络域名询问是进程级代理回调，按「当前在跑命令的会话」归因（`shouldAllowNetworkSilently`）；
  归因失败一律当需要问。

## 4. 状态与持久化

- `SessionRegistryEntry.permissionMode`（`~/.spcode/sessions.json`），照 `planMode` 的做法。
- `session.setPermissionMode` 命令 / `SessionInfo.permissionMode` / `session.permissionmode` 事件。
- `AppSettings.permissionMode` 语义降级为**新会话默认档**（设置页「新会话默认权限模式」）。
- 恢复/唤醒/分叉都会带上模式：`session.open`/`session.activate` 从注册表注入，fork 缺省继承源会话。
- 旧值迁移：`act → auto`；非法值剔除回落 `ask`；`sandbox.autoAllow` 字段退役，存量值读取时丢弃。

## 5. 交互

- 输入框胶囊按钮：`shield` 总是询问 / `shieldCheck` 必要时询问 / `zap` 总不询问（危险色）。
- 点击弹菜单（`role=menu` + `menuitemradio`）：三项各带一句说明、当前项勾选；底部标注
  「仅对当前会话生效，Shift+Tab 循环切换」。
- `Shift+Tab` 在输入框内循环三档（焦点在 Composer 内才拦截，不抢页面焦点导航）。
- 切到「总不询问」需二次确认弹窗；取消保持原档。
- 沙盒未生效（disabled/unavailable）时，非「总是询问」档在按钮与菜单里挂警示；
  设置页在沙盒关闭且默认档非 ask 时追加一条红色警示。
- 模式切换会注入一条模型可见、UI 不显示的说明（照计划模式同一机制），
  让模型知道当前问不问，避免在「总不询问」下反复等确认。

## 6. 刻意取舍

| 取舍 | 原因 |
|---|---|
| 「总不询问」放行 danger/outward 与未知域名 | 真 never 语义（对齐 Codex `never` / Claude `bypassPermissions`）；否则"必要时询问"与"总不询问"就没差别了 |
| 「总不询问」仍拦逃生舱 | 其他自动放行都还有内核边界兜底，唯独逃生舱没有 |
| 凭据区 `deny` 三档都硬拒 | 读密钥没有任何合法场景，不提供"放行"选项 |
| 「总不询问」下 fs-guard `prompt` 自动放行（含写 `~/.spcode/MEMORY.md`） | never 的固有代价；记忆投毒面在这一档重新打开 |
| 沙盒关闭 + auto 免问（不改语义） | 尊重显式选择，用界面警示而非偷偷收紧 |
| 网络归因为近似（按在跑命令的会话） | 代理回调没有会话上下文；保守方向（多问而非少问） |

## 7. 测试

- `test/permission-modes.test.ts`：矩阵纯函数（3 模式 × 4 风险 × bypass/disabled）。
- `test/permission-gate.test.ts`：宿主侧矩阵（含"总是询问档沙盒内 write 必问"的回归）。
- `test/permission-decision.test.ts`：主进程侧只剩规则 + danger/逃生舱不放行。
- `test/sandbox-network-attribution.test.ts`：网络询问归因纯函数。
- `test/sandbox-manager.test.ts`：「总不询问」档域名静默放行（真网门控）、归因表清理。
- `e2e/smoke.spec.ts`：三档菜单 / Shift+Tab / 二次确认 / 设置页三档默认卡。
