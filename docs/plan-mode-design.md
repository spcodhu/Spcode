# 计划模式(Plan Mode)设计

> 目标:Spcode 支持 harness 标准的 Plan 模式——模型先出完整计划,用户批准后才动手。
> 交互参照 Codex / Kimi Work,明确不抄 Finch 小程序的做法。调研结论先列,方案随后。

## 0. 调研结论

**Spcode 现状(已通读源码)**:

- 引擎是 pi SDK(`@earendil-works/pi-coding-agent` v0.87.1),跑在 utilityProcess;`SessionController` 每个会话一个实例,`beforeToolCall` 钩子挂权限网关。
- `AskUserQuestion` 工具已存在,一次调用支持多问题 + 选项 + 自由输入,渲染侧 `QuestionCard` 是模态卡片。copilot cli 的"清单式提问"它天然满足,不用改。
- `TodoWrite` 工具已存在,`ChatView` 顶部有 `TodoPanel` 展示任务清单。需求 4 只差"约束模型必须用",不缺 UI。
- Composer 底部已有纯文本胶囊按钮(询问/行动),新按钮照这个样式加即可。
- 会话注册表 `~/.spcode/sessions.json` 已有 `sessionFile` 创建后回填的机制,计划文件路径照抄这个模式。

**pi 引擎能力(已核实)**:

- `session.setActiveToolsByName()`:运行中动态增删工具,自动重建系统提示,下一轮生效。计划模式禁掉 `edit`/`write` 就靠它。
- `session.sendCustomMessage({ customType, content, display: false })`:注入一条模型可见、UI 不显示的消息(已读 `convertToLlm` 源码,custom 消息会转成 user 消息进上下文;渲染侧 `historyToMessages` 只认 user/assistant,回放不泄漏)。开关计划模式时的指令注入走这条路,不污染用户消息记录。
- pi 官方 examples 里有 `plan-mode` 扩展示例:禁写工具 + bash 白名单 + 状态持久化,思路和本文一致,可抄作业。

**Finch 计划模式(反面教材,已读源码)**:每轮结束在 Composer 弹"执行/继续计划"确认条,退出靠用户点按钮;计划只是聊天文本,不落盘。机械、打断心流,本方案不采用。

**Codex(已读官方 prompt)**:计划工具的核心约束是"完成一个子任务后立刻更新计划状态"。需求 4 照此写进执行约束,并加强为"第一步必须建清单"。

## 1. 目标 / 非目标

目标:

1. Composer 增加计划模式开关(纯文本胶囊样式);开启后输入框上方出现一条 Kimi Work 同款提示条。
2. 计划完整展示在聊天输出里;同时落盘到独立位置 `~/.spcode/plans/<sessionId>.md`,跨重启可查。
3. 无独立"结束计划模式"按钮;模型通过专用工具 `ExitPlanMode` 发起批准卡(复用 QuestionCard 通道),批准后同一轮直接开始执行。
4. 执行必先建 TodoWrite 任务清单,每完成一个阶段立即更新。

非目标:计划多版本历史、计划 diff 视图、Finch 式每轮确认条、计划模式下的自动执行(没批准绝不动手)。

## 2. 交互流程

```
用户点亮「计划」→ 输入框上方出现提示条,模型进入只读计划态
  ↓
模型调研(读类工具 + 只读 bash)
  ↓ 有需要澄清的点
模型一次 AskUserQuestion 抛出清单式问题(现有能力,prompt 约束批量问)
  ↓
模型调 WritePlan 落盘 PLAN.md → 在正文完整输出计划 → 主动调一次 ExitPlanMode
  ↓
弹出批准卡:「计划已就绪,是否开始执行?」[开始执行 / 继续调整]
  ├─ 开始执行 → 计划模式关闭、全量工具恢复 → 工具返回执行约束
  │    → 模型同一轮先 TodoWrite 建清单,再逐步执行,每阶段更新清单
  └─ 继续调整 → 保持计划态,用户补充意见,回到调研环节
```

用户中途直接回复"开始吧"之类的话时,提示词约束模型调用 `ExitPlanMode` 走同一张批准卡;若模型想绕过直接写文件,写工具根本不在它的工具列表里,`beforeToolCall` 兜底拦截并提示它先调 `ExitPlanMode`。任何时候再点一次「计划」按钮可手动退出。

## 3. 技术方案

### 3.1 状态与持久化

- 计划模式状态按会话隔离,权威数据在 agent-host 的 `SessionController`(`planMode: boolean`)。
- 注册表条目(`sessions.json`)加两个字段:`planMode: boolean`、`planFile: string | null`,跟随现有的 `sessionFile` 回填机制写;恢复会话(`session.open`)时把 `planMode` 传进 payload,controller 据此恢复计划态。
- PLAN.md 放 `~/.spcode/plans/<sessionId>.md`。理由:和 `sessions.json` 平级、按会话 id 寻址,不混进引擎的 `agent/sessions/`(那是 pi 的私产),也不污染用户项目目录;删除会话时一并删除。每次 `WritePlan` 整体覆写,计划演变过程聊天历史里本来就有。
- 切换计划模式时用 `sendCustomMessage` 注入 `display:false` 的状态消息("计划模式已开启,只读约束如下…" / "计划模式已关闭,全量工具已恢复"),时间序上最新一条生效,反复开关天然自洽。

### 3.2 工具门禁(两层)

进入计划态:

1. `setActiveToolsByName` 把工具集换成:`read grep find ls websearch webfetch AskUserQuestion WritePlan ExitPlanMode RenameSession`。`edit`/`write` 模型直接看不到;`Task` 子代理也摘掉(子代理有全量工具,会绕过门禁,计划阶段本来也用不上)。
2. bash 保留但走只读白名单(`cat/head/tail/grep/rg/fd/find/ls/pwd/tree/echo`,以及 `git status/log/diff/show/branch` 这类只读子命令);命中白名单自动放行,否则 `beforeToolCall` 返回 block,reason 写明"计划模式只读,批准后解禁"。
3. 兜底:计划态下任何漏网写类调用都在 `beforeToolCall` 拦截,reason 提示"先调用 ExitPlanMode 获得用户批准"。

退出计划态(批准后):恢复完整工具集,注入关闭消息,emit 事件让 UI 撤掉提示条。

### 3.3 两个新工具

`WritePlan`(risk 归为 readonly,不弹权限卡——只写应用自己的目录):

```ts
{ content: string }  // 完整计划 markdown
// 执行:原子写入 ~/.spcode/plans/<sessionId>.md,emit session.plan 事件
// 返回:保存路径
```

`ExitPlanMode`(仅计划态可见):

```ts
{}  // 无参数
// 执行:走 askQuestion 通道弹批准卡「计划已就绪,是否开始执行?」[开始执行/继续调整]
// 批准 → controller 关闭计划态,工具返回:
//   "用户已批准。计划模式已关闭,全量工具恢复。现在开始执行:
//    第一步必须调用 TodoWrite 把计划拆成任务清单(每步一项),
//    之后每完成一个阶段目标,立即更新 TodoWrite 状态。"
// 拒绝/跳过 → 返回"用户希望继续调整计划",计划态不变
```

用专用工具而不是让模型裸调 `AskUserQuestion` 的原因:harness 必须确定性捕获"批准"这一时刻来解禁工具并注入执行约束,靠识别提问文案不可靠。用户看到的卡片就是 QuestionCard,体感与"模型调用 AskUserQuestion 询问"一致。

### 3.4 计划态提示词(注入消息正文要点)

- 你是计划模式:只读调研,禁止任何改动;写工具已被移除,bash 只读。
- 有多个澄清问题时,把问题攒成一次 `AskUserQuestion` 批量抛出(每题 2-4 个选项)。
- 调研充分后:先调 `WritePlan` 保存完整计划,再在回复正文里完整展示计划全文(不截断、不省略)。
- 然后主动调一次 `ExitPlanMode` 询问用户是否开始执行;用户回复表达执行意愿时也必须调 `ExitPlanMode`,不得直接动手。

### 3.5 UI

- Composer 底部工具栏、`询问/行动` 按钮旁加「计划」胶囊(clipboard 图标 + 文字),样式完全照抄现有按钮;激活态用 accent 色(与行动态的 warning 色区分)。
- 激活时,输入框卡片正上方渲染一条独立提示条(参照 Kimi Work:圆角浅色条 + ⓘ 图标),文案:"计划模式:模型先调研并给出完整计划,不会修改文件;你批准后才开始执行。"纯展示,不带按钮。
- 状态按会话切换,新建会话默认关闭。

### 3.6 改动文件清单

| 文件 | 改动 |
|---|---|
| `packages/shared/src/index.ts` | 注册表/元信息加 `planMode`、`planFile`;`HostCommand` 加 `session.setPlanMode`;`HostEvent` 加 `session.planmode` / `session.plan` |
| `agent-host/session-controller.ts` | planMode 状态、`setPlanMode()`、工具门禁(含 bash 白名单)、注册两个新工具、状态消息注入 |
| `agent-host/tools/write-plan.ts` | 新文件,`WritePlan` 工具 + plans 目录写入 |
| `agent-host/tools/exit-plan-mode.ts` | 新文件,`ExitPlanMode` 工具 |
| `agent-host/index.ts` | 分发 `session.setPlanMode`;`session.open` 接收并恢复 planMode |
| `main/index.ts` | 注册表读写新字段;`session.plan` 事件回填 `planFile`;删会话时删 PLAN.md |
| `renderer/src/store.ts` | `SessionState.planMode`、`setPlanMode` action、两个新事件的归并 |
| `renderer/src/components/Composer.tsx` | 「计划」按钮 + 提示条 |

渲染层的 `spcode.d.ts`、`ChatView` 不用动(事件走通用通道,任务清单面板已有)。

### 3.7 测试

Vitest 补:bash 白名单判定、计划态工具门禁(`beforeToolCall` 行为)、`WritePlan` 落盘与覆写、注册表 `planMode`/`planFile` 读写、历史回放不含注入消息。跑 `pnpm test` + `pnpm typecheck` 全绿后手工过一遍完整流程。

## 4. 待你拍板

1. PLAN.md 位置:推荐 `~/.spcode/plans/<sessionId>.md`;备选是项目目录下放 `<cwd>/.spcode/PLAN.md`(好处是跟项目走,坏处是污染仓库、聊天模式没地方放)。
2. 计划态下的 bash:推荐只读白名单;备选全禁(更稳但调研时连 `git log` 都看不了)。
3. `Task` 子代理在计划态下默认摘掉,如你想保留(只读约束传递给子代理)我再加。
