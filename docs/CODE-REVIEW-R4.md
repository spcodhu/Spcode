# Spcode Harness 代码评审报告（R4）

> 评审人视角：高级架构师 · 面向 toC/toB 兼顾的长期项目
> 评审日期：2026-11-17
> 评审基线：`6d31824`（`v0.1.0-beta.39`）
> 上一轮完整评审：R3，2026-10-18，基线 `44fcb8a`（`v0.1.0-beta.12`）
> 评审方式：增量静态审查 + 依赖源码核对 + lint / typecheck / 单测 / 构建 / E2E 实跑

## 修订记录

| 轮次 | 日期 | 基线 | 说明 |
|---|---|---|---|
| R1 初评 | 2026-09-30 | `069c5fc` + 工作区改动 | 首次全量评审 |
| R2 复核 | 2026-09-30 | `dc20aad` | 复核 R1 修复情况 |
| R3 评审 | 2026-10-18 | `44fcb8a` | 安全、重复实现与行业对标；只读，未落文件 |
| R3 整改 | 2026-10-19 | `712b060` | C0–C15、F1–F4 整改提交 |
| R4 增量评审 | 2026-11-17 | `6d31824` | 本轮；重点覆盖 R3 之后 225 个提交、429 个文件 |

> 2026-11-16 20:14 另有一次评审尝试，但只完成初步验证，没有形成结论或报告，不计入已完成轮次。
> 本轮工作区唯一未跟踪文件 `docs/super-agent-redesign-plan.md` 属于产品规划，不纳入代码评审。

## 0. 评审范围与验证记录

### 0.1 范围

本轮为风险驱动的增量评审，覆盖 `44fcb8a..6d31824` 的新增与改动，重点放在 `712b060` 之后：

- `apps/desktop/src/agent-host`：运行保护、模型目录 overlay、在线模型发现、权限网关、文件工具契约、沙盒。
- `apps/desktop/src/main`：模型 IPC、定时任务与错误重试、远程协议 v3、代理、更新器、窗口生命周期。
- `apps/desktop/src/renderer`：模型管理页、模型菜单、运行错误卡、工作区、Modal/Toast、i18n。
- `apps/mobile` 与 `packages/shared`：远程历史、配对/准入、跨端协议、共享类型与 i18n。
- `.github/workflows`、测试配置与新增 E2E。

### 0.2 实跑结果

| 验证项 | 命令 / 范围 | 结果 |
|---|---|---|
| Lint | `pnpm lint` | ✅ 373 个文件通过 |
| Typecheck | `pnpm typecheck` | ✅ 4 个 workspace 全部通过 |
| 桌面单测 | `pnpm --filter @spcode/desktop test` | ✅ 124 文件 / 917 通过 / 5 跳过 |
| 移动端单测 | `pnpm --filter @spcode/mobile test` | ✅ 17 文件 / 129 通过 |
| 根单测 | `pnpm test`（单独运行） | ✅ 两个应用均通过 |
| 构建 | `pnpm build` | ✅ 通过；桌面渲染主 chunk 约 3.03MB、移动端主 chunk 约 1.32MB，均有体积告警 |
| E2E | `pnpm --filter @spcode/desktop test:e2e` | ✅ 68 通过 / 3 跳过（3 条为 Windows 专属） |

补充：在 lint、typecheck、单测三路并发施压时，单测曾出现 `i18n-visible-text.test.ts` 超时，并伴随 `store.ts:627` 的延迟定时器在测试环境拆除后访问 `window`。三路分开运行时全部通过，因此不计为产品功能失败，但记入 P2 测试稳定性问题。

## 1. 结论摘要

**本轮没有发现新的 P0。R3 的 5 个 P0 安全根因均已闭环，但 R3 之后的增量引入了 4 个 P1 问题。**

| 编号 | 问题 | 影响 |
|---|---|---|
| P1-1 | 运行保护未覆盖引擎的隐式续跑 | `maxModelTurns` 可被绕过；暂停卡可能被下一次 `agent_start` 清掉 |
| P1-2 | 被禁用模型仍可被新会话实际调用 | “停用”只在列表层生效，可能在用户不知情时继续产生费用 |
| P1-3 | CI 的 push 门禁指向不存在的 `main` | 默认分支 `master` 的直接推送不跑质量门禁 |
| P1-4 | Anthropic 在线模型发现请求错路径 | 标准 Base URL 下请求 `/models` 而非 `/v1/models`，功能失败 |

**总体判断：当前适合继续发测试版，不建议直接发布 `0.1.0` 稳定版。** 先修 P1-1 至 P1-4，再处理 P2 中的模型页状态与远程可观测性缺口。

## 2. R3 安全整改复核

R3 的核心 P0 在当前代码上已形成多层防线，本轮未复现旧问题：

| R3 项 | 当前状态 | 证据 |
|---|---|---|
| P0-1 文件工具越过沙盒读密钥 | ✅ 已修 | `fs-guard.ts` 路径守卫 + `file-tool-contract.ts` 同名覆盖；凭据区硬拒绝 |
| P0-2 Task 子代理无权限网关 | ✅ 已修 | `tools/task.ts` 注册同一 `createBeforeToolCallGate`，且不开放逃生舱 |
| P0-3 任意 `file://` 导航继承 preload | ✅ 已修 | 仅放行应用入口；渲染进程 `sandbox: true` |
| P0-4 远程 auth 可重放 | ✅ 已修 | 挑战-应答认证、设备级 seq 持久化、v3 准入令牌 |
| P0-5 设置密钥明文回传渲染层 | ✅ 已修 | `settings.json` 0600、`redactSettingsForRenderer`、掩码还原 |

工程基建方面也有明显推进：Biome、CI、模型 overlay 原子写、远程协议共享层、错误重试、运行保护与模型管理测试均已落地。**但 CI 门禁存在分支配置错误，见 P1-3。**

## 3. P1 问题

### P1-1 · 运行保护未覆盖引擎的隐式续跑

**位置**

- `apps/desktop/src/agent-host/session-controller.ts:410-413`
- `apps/desktop/src/agent-host/run-guard.ts:86-87`
- `apps/desktop/src/renderer/src/store.ts:868-872`
- 依赖行为：`@earendil-works/pi-agent-core` 的 `agent-loop.js` 与 `pi-coding-agent` 的 `agent-session.js`

**触发条件**

1. **截断回合继续**：模型持续返回 `stopReason="length"` 且带 `toolCall`。引擎会把截断的工具调用判失败，但 `hasMoreToolCalls` 仍为真并继续下一回合；RunGuard 只把 `stopReason === "toolUse"` 或扩展 `continue` 视为继续，因此不检查回合上限。
2. **排队插话继续**：用户在运行中发送 steering。引擎在 `finishTurn` 之后才 drain steering 队列并继续；RunGuard 同样看不到这次隐式续跑。
3. **暂停被自动续跑清掉**：达到阈值且返回 `end` 时，如果 steering 队列仍有消息，外层 `AgentSession` 会因 `hasQueuedMessages()` 再调用 `agent.continue()`。下一轮 `agent_start` 会把渲染层的 `pendingGuard` 清空；RunGuard 此时只返回 `end`，不会重新发暂停事件，最终实时界面看不到暂停卡。

**影响**

- 配置的模型回合预算不是硬上限，异常模型或持续插话可超出预算继续消耗 token。
- 运行保护的暂停可能只落到持久化历史，实时界面无卡、用户不知道为何停止。
- 若暂停期间还执行了一次工具调用，安全边界会被“再多跑一轮”削弱。

**建议修复**

- 不要只根据 `stopReason` 推断继续；应把 steering 队列、截断工具调用和扩展 `continue` 都纳入引擎级续跑判定。
- 暂停后阻止外层 `hasQueuedMessages()` 再次续跑（清空/冻结队列，或在暂停状态直接中止外层循环），并保证暂停事件在最终 settled 前不会被普通 `agent_start` 清掉。
- 增加三类回归：`length + toolCall`、`stop + 排队 steer`、暂停时仍有 steer。

**置信度**：高（结合当前源码与依赖实现确认）。

### P1-2 · 被禁用模型仍可被新会话实际调用

**位置**

- `apps/desktop/src/renderer/src/store.ts:1203-1216`：新草稿直接使用 `settings.defaultModel`
- `apps/desktop/src/main/index.ts:466-468`：只在 `models.list` 返回值上过滤
- `apps/desktop/src/agent-host/index.ts:760-768`：`session.create` 直接接受渲染层传入的模型
- `apps/desktop/src/renderer/src/components/Composer.tsx:933-938`：候选列表找不到时只显示“选择模型”

**触发步骤**

1. 在输入框选择一个模型 M，使其成为默认模型。
2. 到设置 → 模型，停用 M，或停用 M 所属供应商。
3. 新建聊天并直接发送消息。

**实际结果**

新会话仍会把 M 传给宿主并正常调用；但模型胶囊因为 `models` 已过滤掉 M 而显示“选择模型”。界面显示与实际执行模型不一致。用户停用模型的动机（成本、隐私、供应商不可用）没有被执行层尊重。

**建议修复**

- 模型启用状态必须成为会话创建时的权威校验：宿主拒绝已停用模型，或明确解析到第一个可用模型。
- 停用默认模型时同步清理/重解析 `settings.defaultModel`。
- 加一条回归测试：停用默认模型 → 新会话 → 断言实际模型不是已停用项。

**置信度**：高。

### P1-3 · CI 的 push 门禁指向不存在的 `main`

**位置**：`.github/workflows/ci.yml:5-9`

**证据**

- workflow 配置为 `push.branches: [main]`。
- 远程默认分支和本地当前分支均为 `master`（`git remote show origin` 明确显示 `HEAD branch: master`）。
- 当前项目的日常提交直接 push 到 `master`，不会触发 push 门禁。

**影响**

R3-C0 宣称“质量门禁必须在提交路径上”，但实际直接推送完全绕过 lint/typecheck/单测。PR 触发的检查仍有效，但项目日常流程并不依赖 PR。该配置是 2026-10-07 从自动 CI 切回手动触发后遗留的分支名错配。

**建议修复**：改为 `branches: [master]`，或删除 `branches` 过滤让所有分支 push 都跑；同时补一条 workflow 配置测试/检查，避免再次与默认分支漂移。

**置信度**：高。

### P1-4 · Anthropic 在线模型发现请求错路径

**位置**

- `apps/desktop/src/agent-host/model-discovery.ts:217-218`
- 测试缺口：`apps/desktop/test/model-discovery.test.ts:49-85`

**证据**

- 当前实现调用 `endpoint(input.baseUrl, "models")`。
- Pi 的 Anthropic 标准 Base URL 是 `https://api.anthropic.com`（无 `/v1`）。
- Anthropic 官方 SDK 的模型列表接口是 `/v1/models`。
- 因此标准配置会请求 `https://api.anthropic.com/models` 并得到 404。
- Anthropic 测试只检查认证头、分页参数和解析结果，**没有断言第一页 URL**，所以错误路径仍能全绿。

**触发步骤**：添加自定义供应商 → 协议选 `anthropic-messages` → Base URL 填 `https://api.anthropic.com` → 获取模型列表。

**建议修复**：Anthropic 使用 `v1/models`，并兼容用户已经填写 `/v1` 的 Base URL（避免 `/v1/v1/models`）；测试必须断言完整第一页 URL。

**置信度**：高。

## 4. P2 问题

### P2-1 · 重新启用模型后选择器不会恢复

**位置**

- `apps/desktop/src/renderer/src/components/ModelsPage.tsx:85-113`：启停只保存设置
- `apps/desktop/src/renderer/src/store.ts:1816-1824`：`saveSettings` 没有刷新模型缓存
- `apps/desktop/src/main/index.ts:466-468`：`models.list` 已在主进程过滤

**触发步骤**：停用模型/供应商 → 重启应用，或在停用期间点“刷新模型目录” → 重新启用 → 打开 Composer、Fork 或定时任务模型选择器。

**结果**：模型仍缺席，直到再次刷新模型列表或重启。当前 E2E 只做连续启停，没有覆盖“停用期间刷新/重启”的路径。

**修复**：启停后调用 `refreshModels()`；或让 `models.list` 始终返回全量目录，由所有选择器统一按设置过滤。后者的状态一致性更好。

**置信度**：高。

### P2-2 · Fork 会静默继承已停用的源模型

**位置**

- `apps/desktop/src/renderer/src/components/ForkDialog.tsx:50,59-66`
- `apps/desktop/src/main/session-helpers.ts:95-100`

**触发步骤**：源会话使用模型 M → 停用 M → 打开 Fork 弹窗，不改模型直接确认。

**结果**：下拉显示“选择…”，但确认时 `selectedModel=null` 被转换成 `model=undefined`，主进程再用 `source.model` 补回 M。Fork 实际继续使用被停用模型。

**修复**：源模型不可用时要求用户显式选择可用模型，或解析到默认可用模型；不要用 `undefined` 表达“用户未选择”。

**置信度**：高。

### P2-3 · 模型页搜索与分页在列表缩短后状态失效

**位置**

- `apps/desktop/src/renderer/src/components/ModelsPage.tsx:347-358,470,596`

**两个可复现场景**

1. 供应商有 6 个模型，搜索只匹配 M；删除 M 后剩 5 个，搜索框因 `> 5` 条件消失，但旧查询仍在过滤，页面显示“没有匹配模型”，且没有控件可清除查询。
2. 61 个模型进入第 3 页；删除末页唯一模型后总页数变 2，但真实 `page` 仍为 2；第一次点“上一页”执行 `2→1`，界面无变化，需点第二次。

**修复**：数据缩短时同步归一化 `query` 与 `page`；搜索框不要因数量变化而卸载，或用 effect 清理不可见查询。分页按钮基于 `currentPage` 而不是原始 `page` 计算。

**置信度**：高。

### P2-4 · `openai-codex-responses` 的系统消息角色配置是空操作

**位置**

- `apps/desktop/src/renderer/src/components/ModelsPage.tsx:1005-1023`
- `apps/desktop/src/renderer/src/components/ModelDiscoveryModal.tsx:24-30`
- 依赖实现：`pi-ai/dist/api/openai-codex-responses.js:380-393`

**证据**：UI 把 Codex 协议列入支持角色配置，并持久化 `compat.supportsDeveloperRole`。但 Codex 请求构建使用 `includeSystemPrompt: false`，随后把初始系统提示写入顶层 `instructions` 字符串；`supportsDeveloperRole` 控制的角色转换不会作用于这段主系统提示。

**结果**：用户为 Codex 模型选择 `system` 或 `developer`，实际初始提示语义相同，配置界面具有误导性。

**修复**：从角色可选协议中移除 Codex，或在 Codex 适配层明确实现 `instructions` / developer 语义；用真实请求体测试锁定。

**置信度**：高。

### P2-5 · 远程端看不到运行保护暂停及原因

**位置**

- `apps/desktop/src/main/remote/aggregator.ts:43-104`：没有 `session.runGuard` 分支，落入 default 丢弃
- `packages/shared/src/remote-history.ts:121-170`：历史只处理 user / assistant / compactionSummary
- `packages/shared/src/index.ts:463`：只有桌面命令 `session.continue`，没有远程续跑命令

**触发条件**：手机在线时达到回合上限或重复工具阈值；或暂停后重新拉取手机历史。

**结果**：宿主发出 `session.runGuard`，aggregator 丢弃；随后 `agent_settled` 映射为 idle。手机只看到任务“正常结束”，不知道发生了安全暂停，也无法带原暂停上下文明确续跑。

“继续按钮仅桌面端”可以是产品取舍，但**暂停原因至少应透传并持久化到远程历史**，否则远程用户无法判断任务为何停止。

**置信度**：高。

### P2-6 · 在线发现的两个边界：短密钥不脱敏、总耗时可能超过 IPC 超时

**位置**

- `apps/desktop/src/agent-host/model-discovery.ts:70-75`：仅对长度 ≥3 的密钥脱敏
- `apps/desktop/src/agent-host/model-discovery.ts:8-10,217-259`：最多 20 页、每页 15s
- `apps/desktop/src/main/index.ts:374-387`：`models.discoverModels` 总超时 60s

**场景**

- API Key 只有 1–2 字符，且上游 401 响应回显该密钥时，`redact()` 不会处理，错误原文会到渲染层。短密钥本身安全性有限，但脱敏逻辑不应按长度跳过。
- 多页发现每页都低于 15s，总和可超过 60s；UI 报超时，宿主仍继续请求，重试会产生并发重复认证请求。

**修复**：所有非空密钥值都参与脱敏；分页流程增加总 deadline 与取消信号，或把 IPC 超时按页数上限动态计算。

**置信度**：高。

### P2-7 · 合法供应商 ID `toString` 等会被误判为已存在

**位置**

- `packages/shared/src/models-overlay.ts:105-119`
- `apps/desktop/src/agent-host/model-overlay.ts:126`

**触发步骤**：新增供应商，ID 填 `toString`，其余字段合法。

**结果**：`data.providers[provider]` 命中的是 `Object.prototype.toString` 继承属性，代码误判供应商已存在并返回 `models.providerExists`。`valueOf`、`hasOwnProperty` 同理。ID 校验目前只排除了 `__proto__`、`prototype`、`constructor`。

**修复**：使用 `Object.hasOwn(data.providers, provider)` 或 `Map`；ID 校验与存在性判断使用同一套字典安全语义。

**置信度**：高。

### P2-8 · 单测对并发负载敏感，延迟定时器会跨测试泄漏

**位置**

- `apps/desktop/test/i18n-visible-text.test.ts:94`：同步扫描全部 TSX，使用 Vitest 默认 5s 超时
- `apps/desktop/src/renderer/src/store.ts:618-627`：草稿持久化 500ms 定时器
- `apps/desktop/test/store.test.ts:82-85`：只调用 `teardownHostEvents()`，没有清理草稿定时器/订阅标记

**现象**：lint、typecheck、单测三路并发时，`i18n-visible-text` 超时；随后 `store.ts:627` 的定时器在 `window` 已被 `vi.unstubAllGlobals()` 移除后触发，Vitest 报 unhandled error。三路分开运行时全部通过。

**影响**：不是产品功能失败，但会让本地高负载验证或 CI 并行阶段出现假红，削弱测试可信度。

**修复**：给文本扫描测试显式 timeout（或缓存文件列表）；在测试清理里取消草稿定时器并重置订阅标记，或把调度器改为可注入/可清空的模块级服务。

**置信度**：高。

## 5. 值得保留的设计与实现

1. **R3 安全整改是有效的**：文件工具路径守卫、Task 子代理同一权限网关、远程挑战-应答、设置脱敏都形成了“网关 + 执行层”的双层防线。
2. **模型 overlay 的文件职责划分清晰**：手写 `models.json` 只读、`models.custom.json` UI 读写、`models.managed.json` 合成，原子写与来源/可删性判定表设计合理。
3. **在线发现的安全基线不错**：手动重定向、2MB 流式上限、分页游标防环、错误脱敏、协议白名单，说明作者已经按不可信上游设计。
4. **运行保护的 UX 方向正确**：暂停复用现有错误卡、自定义消息可持久化、继续走完整 AgentSession 生命周期，比直接抛异常更利于恢复；问题在引擎续跑边界，而不是界面设计。
5. **远程 v3 与双端历史测试覆盖扎实**：挑战-应答、seq 回滚、设备分槽、历史去重与重连都有真实链路测试。
6. **i18n 覆盖面明显提升**：可见文案测试、跨端资源键一致性、运行错误只本地化应用文案，边界把握得比较克制。

## 6. 建议排期

**立即（稳定版之前）**

1. 修 P1-1：把引擎实际续跑纳入 RunGuard；暂停时冻结/清理 steering，避免自动续跑清卡。
2. 修 P1-2：会话创建校验模型启用状态；停用默认模型时重解析。
3. 修 P1-3：CI push 分支改为 `master` 或取消分支过滤。
4. 修 P1-4：Anthropic 使用 `/v1/models`，补 URL 断言。

**下一迭代**

5. P2-1/P2-2：统一模型目录与启用状态的单一事实源，修 Fork 隐式继承。
6. P2-3/P2-4：模型页状态归一化；Codex 角色配置去伪存真。
7. P2-5/P2-6：远程透传暂停原因；发现流程增加总 deadline 与完整脱敏。
8. P2-7/P2-8：字典安全与测试隔离。

**发布门禁建议**

- 当前没有 P0，但 P1-1 会让安全预算失效、P1-2 会让“停用”失真，两者都应在稳定版前关闭。
- 测试版可以继续发，但建议在 P1-1/P1-2 修复后重新跑完整单测 + E2E，并把 CI 分支修复纳入同批提交。
- `docs/CODE-REVIEW.md` 是 R1/R2 历史报告，已在上方标记并链接本报告；后续以本文件为最新结论。

## 7. 评分（满分 5）

| 维度 | R4 | 说明 |
|---|---|---|
| 架构与模块化 | 4.4 | 权限网关、模型 overlay、远程共享层持续收敛 |
| 正确性 / 健壮性 | 3.8 | R3 安全根因已解，但运行保护与模型启停仍有语义漏洞 |
| 安全 | 4.2 | 多层防线有效；本轮无新 P0；剩余为边界与可观测性问题 |
| 测试 | 4.1 | 覆盖显著扩大；并发负载下仍有假红与定时器泄漏 |
| 工程基建 | 4.2 | lint/typecheck/test/build/E2E 齐全；CI push 分支配置需修 |
| 可观测性 | 3.6 | 运行错误卡与用量账本不错；运行保护在远程端仍不可见 |

## 附录 A · 关键证据索引

| 主题 | 文件 |
|---|---|
| 运行保护续跑判定 | `apps/desktop/src/agent-host/session-controller.ts:410-413` |
| 暂停事件清空 | `apps/desktop/src/renderer/src/store.ts:868-872,923-930` |
| 模型列表过滤 | `apps/desktop/src/main/index.ts:466-468` |
| 新会话默认模型 | `apps/desktop/src/renderer/src/store.ts:1203-1216` |
| CI 分支 | `.github/workflows/ci.yml:5-9` |
| Anthropic 发现路径 | `apps/desktop/src/agent-host/model-discovery.ts:217-218` |
| Fork 模型继承 | `apps/desktop/src/main/session-helpers.ts:95-100` |
| 模型页状态 | `apps/desktop/src/renderer/src/components/ModelsPage.tsx:347-358,470,596` |
| 远程暂停丢弃 | `apps/desktop/src/main/remote/aggregator.ts:43-104` |
| 发现脱敏/超时 | `apps/desktop/src/agent-host/model-discovery.ts:70-75,217-259` |
| 供应商 ID 字典 | `apps/desktop/src/agent-host/model-overlay.ts:126` |
| 测试定时器 | `apps/desktop/src/renderer/src/store.ts:618-627` |
