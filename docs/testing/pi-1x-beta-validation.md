# Pi 1.x 升级与三批增强 · 收益 / 差异 / 跨平台验收清单

> 状态：清单模板。实际执行结果与 CI 链接记录在本次发布的 `docs/code-review/R<N>` 报告中；
> 本文件不填写任何未经执行的“通过”。
>
> 基线：`v0.1.0-beta.42`（Pi 0.87.1）→ 目标：`v0.1.0-beta.43`（Pi 1.5.2，实施起点复核）。
> 范围：macOS arm64/x64、Windows x64 桌面 + 手机 PWA 回归。不新增 Linux 安装包，不开发 Windows OS 沙箱，不做 worktree。

## 1. 本次升级“得到了什么”（之前 → 之后）

| 能力 | 之前（beta.42） | 之后 | 主要证据/入口 |
|---|---|---|---|
| Pi 底座 | 0.87.1 + 本地 isError 补丁 | 1.5.2 三包同版本；补丁已被上游吸收并移除 | `apps/desktop/package.json`、`test/tool-error-propagation.test.ts` |
| 后台预热 | 默认 streaming 预热 | 宿主会话显式 `cacheWarming: off`，不引入 idle 空闲请求 | `agent-host/pi-session-config.ts` |
| 原生 MCP/Codemode | 不存在 | 上游具备但本版**不开放**；继续走宿主 MCP 桥，避免重复连接/未受控工具 | `disabledBuiltinExtensions` |
| 权限钩子 | 直接覆盖 `agent.beforeToolCall`，丢失扩展 veto；嵌套 `ctx.executeTool` 绕过 | 强制末尾扩展注入，普通+嵌套共用 `tool_call` 链；保留上游 veto | `agent-host/permission-extension.ts` |
| 审批参数 | 读原始 `toolCall.arguments` | 读 prepareArguments 后的最终参数，重校验+冻结快照，批准绑定参数摘要/策略版本 | `permission-gate.ts`、`permission-extension.ts` |
| 授权作用域 | 单次 / 项目总允许（危险可沉淀 exact） | once / session / project；危险与逃生舱仅 once；对外/复合仅 exact；会话级不跨 fork/重启 | `shared/permission.ts`、`main/agent-bridge.ts` |
| 撤销 | 仅设置页逐条删项目规则 | 新增“撤销临时授权”：递增策略版本、结清待决、迟到回复失效 | `SettingsPage.tsx`、`IPC.permissionRevoke` |
| 网络授权 | 进程级全局 host 缓存，跨会话串权 | 会话级 host:port 授权，先唯一归因再查缓存；never 静默放行不沉淀 | `sandbox/manager.ts` |
| 折叠证据恢复 | 占位符建议“重跑原操作” | 稳定引用 + ReadEvidence 分页回读当时原文，绝不重跑 | `context-evidence.ts`、`tools/read-evidence.ts`、`microcompact.ts` |
| 上下文展示 | 总量环 + 压缩摘要 | 分项估算（系统/规则记忆/schema/摘要/近期/工具/证据）+ provider 总量 + 输出预留，来源分离、unknown 非 0 | `context-budget.ts`、`Composer.tsx` |
| 稳定约束 | 模式说明注入历史，可能被压缩 | 宿主状态每请求投影注入，不随压缩丢失 | `context-policy.ts` |
| 子任务输入 | description + prompt | 目标/背景/范围/验收/证据引用/角色；宿主补齐 cwd 与上限 | `tools/task.ts`、`shared/task-runtime.ts` |
| 子任务结果 | 末条 assistant 文本 | 结构化 TaskResult（状态/摘要/证据/产物/用量/未解决项），状态由宿主生成 | `tools/task.ts` |
| 子任务预算 | 无独立预算 | 单任务 64 回合/15 分钟；整树 128 回合/30 分钟；最多 3 活跃；深度 2；80% 提醒；末票总结 | `task-runtime.ts` |
| 写入并发 | 同 cwd 并行写 | 只读并行；写任务全生命周期 FIFO 租约；主会话写工具同租约；持锁禁止等待写子任务 | `workspace-writer.ts` |
| 子任务权限 | 继承父实时模式 | 创建时上限 ∩ 父实时 ∩ 角色能力；父放宽不扩张；沙箱放松后 fail-closed | `tools/task.ts` |

## 2. 与之前有区别、需要重点回归的行为

1. **危险命令不再“总允许”**：权限卡危险/逃生舱只剩单次批准；旧版沉淀的危险 exact 项目规则升级后需重新确认（迁移提示）。
2. **对外/复合命令持久授权收紧为完整 exact**：旧前缀规则不再覆盖参数变化。
3. **旧 PWA 缓存客户端**：`rememberProject` 不再沉淀持久规则，仅单次；需刷新客户端获得 scope 协议。
4. **折叠结果不可“重跑恢复”**：模型被引导用 ReadEvidence；无证据读取器时不产生不可恢复占位符。
5. **子任务默认只读**：需要写必须显式 `role: "write"`；只读任务无 Shell/MCP。
6. **Windows 仍无 OS 沙箱**：审批 + 文件路径守卫降级，界面明确标注；不宣称内核隔离。
7. **空闲不再预热缓存**：长时间空闲后首请求可能略慢（无后台预热请求）。

## 3. 自动验证（tag 前必须全绿）

- 根目录：`pnpm lint && pnpm typecheck && pnpm test`。
- `pnpm --filter @spcode/mobile build` + `pnpm --dir apps/desktop check:mobile`。
- `pnpm --filter @spcode/desktop build` 后 `pnpm --filter @spcode/desktop test:e2e`（临时 SPCODE_HOME）。
- 手动 CI（`workflow_dispatch`，指定完整 commit SHA）：macOS/Windows 矩阵跑上述全部 + `electron-builder --publish never` + `scripts/packaged-smoke.mjs`，上传日志与预览包。
- 新增专项单测：`context-evidence`、`task-runtime`、`context-budget`、`permission-scope`、`pi-session-config`。

## 4. 跨平台人工验收矩阵

状态取值：`自动通过 / 人工通过 / 未实机验证 / 失败 / 不适用`。每项记录环境、版本、commit、时间、证据。

### macOS arm64（本机）
- [ ] 全新安装启动；beta.42 覆盖升级后旧会话可恢复/fork/导出。
- [ ] 权限卡：普通写（会话/项目）、对外（仅 exact）、危险（仅单次）、逃生舱确认。
- [ ] 撤销临时授权后待决卡消失、迟到回复无效；项目规则逐条删除。
- [ ] Seatbelt：工作区外写被拒；白名单外域名弹窗；同 host 不同会话不串权。
- [ ] 子任务：只读并行、写串行、取消释放锁与槽、预算耗尽交回 partial。
- [ ] 证据回读：折叠后 ReadEvidence 取回原文；重启/fork 后引用可达；跨会话拒绝。
- [ ] 上下文分项与压缩摘要展示；自动更新检查。

### macOS x64（需设备）
- [ ] 安装启动、Pi/原生资源加载、旧会话恢复、Shell/沙箱、自动更新。
- 无设备时标 `未实机验证`（CI 交叉打包不等于实机通过）。

### Windows x64（CI + 实机）
- [ ] NSIS 与 ZIP 安装启动；中文/空格/长路径。
- [ ] Git Bash 与 PowerShell 工具；无 OS 沙箱提示正确；junction/驱动器路径守卫。
- [ ] 权限 scope/撤销；取消进程树清理；重启后会话级授权清空。
- [ ] 子任务写串行与取消；证据回读；自动更新。

### 手机 PWA（iOS Safari / Android Chrome）
- [ ] 单次/会话/项目批准与拒绝；桌面—手机双端撤卡同步。
- [ ] 断线重连后待决请求恢复；旧缓存客户端刷新提示。
- [ ] 上下文分项与子任务结果展示。

### 真实厂商（需用户授权与合规接入方式）
- [ ] 至少一个 API key 供应商真实请求成功（不记录密钥）。
- [ ] 订阅渠道仅按官方允许方式验证；未授权项标 `未实机验证`。

## 4.1 Windows E2E 预检发现与修复（既有兼容问题，非本次三批引入，已全部修复）

CI 此前仅 macOS 跑 E2E；本次新增 Windows 预检首次暴露以下既有问题，经多轮 Windows CI 迭代已全部修复（最终 run 44772777242：**Windows 30 过 / 1 跳过 / 0 败**；macOS 本地全量 28 过 / 3 跳过 / 0 败）：

| 用例 | 根因 | 修复 |
|---|---|---|
| app-shell 启动就绪 | `app.isActive()` 仅 macOS 提供，Windows 抛 TypeError | typeof 守卫，非 macOS 按 false 断言 |
| appearance 分隔条拖动 | 绝对像素断言假设 mac 默认窗宽；鼠标拖拽在 Windows 受指针捕获/布局约束不稳定 | 改 ResizeHandle 确定性键盘微调（ArrowRight×2），断言相对增量 |
| window-chrome 顶栏融合 | Electron 各版本 `navigator.windowControlsOverlay` JS API 不一致 | 改用应用同款 CSS `env(titlebar-area-width)` 探测覆盖层左边界 |
| window-chrome 关闭确认 | 慢启动 CI 监听器竞态 + quit 即退出进程致 click 后校验撞 browser closed | 先等 brand 可见、显式等对话框、提前挂退出监听、quit 用 dispatchEvent 容忍退出竞态 |
| workspace 文件链接同排 | Windows 字体度量致链接换行（同排几何断言过严） | 改验证行内级 display（未变块级卡片），保留单行高度检查 |

说明：发布门禁 release.yml 跑双平台单测+构建+打包（均已绿），不跑 E2E；上述为额外预检发现的既有 Windows E2E 缺口，与本次三批改动无关，已在 master 修复。macOS E2E/打包/冒烟全绿。第六轮 macOS CI 的 run-error 失败为抖动（同代码前几轮均过、本地复跑通过），非回归。

## 5. 回退指引

1. 退出应用。
2. 保留升级后数据副本（应用数据目录），不要直接删除。
3. 恢复升级前备份的设置/注册表/会话副本（首次迁移时应用自动备份）。
4. 安装旧版安装包。
5. 说明：升级后新增的会话级状态不会回到旧版；未经验证不承诺直接降级兼容。
