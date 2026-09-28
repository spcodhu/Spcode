# Spcode Harness 执行计划

> 基于《agentic-code-深度解析.md》+ 对 pi v0.87.1（最新版）与 Finch 1.7.1 本地实物的核查。
> 目标：以 pi 为内部引擎的桌面 Agentic Code 工作台，第一版即可承担真实工作与长程任务。

## 0. 关键调研结论（决定选型的依据）

| 事项 | 结论 |
|---|---|
| pi 最新版 | v0.87.1，npm 包 `@earendil-works/pi-coding-agent` / `pi-agent-core` / `pi-ai`，MIT 协议 |
| pi 嵌入方式 | 官方一等公民 **SDK**（`createAgentSession()`，进程内 TypeScript API）；另有 RPC 子进程模式（Finch 走的路线）。SDK 已覆盖：会话持久化/分支/压缩、模型与 thinkingLevel 切换、自定义工具、steering/follow-up、事件流订阅 |
| 用量统计 | pi 消息事件自带 `usage`（含 `cacheRead`/`cacheWrite`、成本单价表），逐模型归集由我们实现 |
| 思考强度 | pi 的 `thinkingLevel`（off/low/medium/high…）经 compat 层翻译成各家真实参数（reasoning_effort / thinking.type / enable_thinking 等 11 种格式）——"实际生效"由引擎保证 |
| 内置工具 | read/write/edit/bash/powershell/grep/find/ls 齐全；WebSearch/WebFetch/AskUserQuestion/TodoWrite/Task 由我们以 `customTools` 补充（pi 支持） |
| Finch 路线 | vendor fork + Bun 编译二进制 + RPC。**我们不走这条路**（见下） |

**集成方式决策（推荐）：npm SDK + Electron `utilityProcess`**。
pi 跑在 Electron 的 utilityProcess（纯 Node 环境）里，与渲染进程用类型化 IPC 通信。相比 Finch 的 vendor 二进制方案：升级 pi = 改 package.json 版本号，无需维护 fork 和 Bun 编译链；相比主进程内嵌：引擎崩溃不拖垮 UI，长任务的 CPU/IO 不阻塞窗口。进程隔离的收益与 Finch 相同，维护成本远低于它。

## 1. 技术栈

- 语言：TypeScript 全栈；包管理 pnpm workspace
- 桌面：Electron（最新稳定）+ electron-vite（main/preload/renderer 三端构建）
- 前端：React 18 + Zustand（状态）+ Tailwind CSS + Streamdown 系 Markdown 渲染 + highlight.js/Shiki 代码高亮
- 引擎：`@earendil-works/pi-coding-agent` SDK（utilityProcess 宿主）
- 持久化：SQLite（better-sqlite3，会话索引/用量统计）+ JSONL/Markdown 文件（记忆、会话详情，人类可读）
- 构建发布：electron-builder + electron-updater + GitHub Actions + GitHub Releases
- 测试：Vitest（单元）+ Playwright（Electron E2E）+ 子代理自测

## 2. 仓库结构

```
spcodhu-harness/
├── apps/desktop/            # Electron 应用
│   ├── src/main/            # 主进程：窗口、IPC 网关、更新器、托盘
│   ├── src/preload/         # 安全桥（contextBridge，白名单 API）
│   ├── src/agent-host/      # utilityProcess：pi SDK 宿主（引擎层）
│   └── src/renderer/        # React UI
├── packages/
│   ├── core/                # 纯 TS 领域模块（不依赖 Electron，可单测）
│   │   ├── memory/          # 分层记忆 + 蒸馏
│   │   ├── usage/           # token 用量归集（按模型/会话，含缓存命中）
│   │   ├── quota/           # 各厂商 token plan 配额查询适配器
│   │   └── theme/           # 主题 schema、AI 主题生成、字体导入
│   └── shared/              # 主/preload/renderer/引擎共享类型与 IPC 协议
├── .github/workflows/       # CI（测试）+ Release（构建发布）
└── docs/
```

## 3. 架构

```
┌─ Renderer (React) ────────────────────────────┐
│  聊天/项目会话 UI · 设置 · 主题 · 用量面板     │
└──────▲───────────────────────────▲────────────┘
       │ contextBridge IPC         │ 事件推送
┌──────┴───────────────────────────┴────────────┐
│  Main 主进程                                   │
│  会话管理 · 权限网关 · 记忆蒸馏调度 ·          │
│  用量/配额服务 · 自动更新 · 配置存储           │
└──────▲────────────────────────────────────────┘
       │ 类型化 MessagePort 协议（镜像 pi 事件流）
┌──────┴────────────────────────────────────────┐
│  Agent Host (utilityProcess, Node)             │
│  pi SDK: createAgentSession / AgentSessionRuntime
│  内置工具 + 自定义工具(WebSearch/WebFetch/     │
│  TodoWrite/AskUserQuestion/Task 子代理…)       │
└──────▲────────────────────────────────────────┘
       │ HTTPS/SSE
   各家模型 API（OpenAI/Anthropic/DeepSeek/z.ai/月之暗面…）
```

权限网关放在主进程（镜像 Finch）：pi 的 `beforeToolCall` 钩子 → 主进程按工具风险分级（只读自动放行 / Bash 与网络需确认 / acceptCalls 模式下仅危险命令确认）→ 渲染进程弹确认卡片。

## 4. 功能映射（需求 → 实现）

| 需求 | 实现方案 |
|---|---|
| 聊天 / 项目双模式 | 会话模型含可选 `cwd`；聊天模式用临时工作目录，项目模式选文件夹并做项目级资源发现（AGENTS.md 等） |
| 记忆机制 | 分层：SOUL.md / USER.md / MEMORY.md（启动注入，容量上限强制蒸馏）/ 每日日志（可搜索不回注）/ 项目记忆 / lessons.md（带信任分）。会话结束触发蒸馏子任务写回记忆 |
| Token 消耗同步 | 订阅 pi 事件流提取 usage（input/output/cacheRead/cacheWrite + 单价表算成本），按模型×会话×日归集入 SQLite；UI 实时显示当前会话与累计，含缓存命中率 |
| 思考强度选择 | 映射 pi thinkingLevel；仅显示当前模型实际支持的档位；切换即下轮生效 |
| Token plan 配额 | `packages/core/quota` 适配器接口，每厂商一个实现（走厂商余额/配额 API），UI 卡片参考 Finch；v1 覆盖范围待你勾选（见确认问题） |
| 主题与字体 | CSS 变量主题系统，主题=JSON（可 AI 生成后导入），默认暗色主题（我设计）；支持导入本地字体文件（TTF/OTF/WOFF2）并选择 UI/等宽字体 |
| 全量 Agentic 工具 | pi 内置 8 件 + 自研 WebSearch(抓 Bing)/WebFetch(转 Markdown)/TodoWrite/AskUserQuestion/Task(子代理)/Skill 加载，直接达到可干活状态 |
| 长程任务 | pi 自带自动压缩(compaction)+溢出恢复+可中断重试；我们加：后台任务（窗口关闭继续跑）、TodoWrite 进度外存、会话可恢复 |
| 自动更新 | electron-updater 轮询 GitHub Releases；Actions 打 tag 自动构建 macOS(arm64/x64)+Windows 安装包并发布 Release |

## 5. 里程碑

- **M1 地基**：仓库/构建链/CI；utilityProcess 宿主接通 pi SDK；最小 UI 跑通"发消息→流式回复→工具执行→权限确认"闭环
- **M2 核心体验**：聊天/项目双模式、会话持久化与切换、完整工具集（含 WebSearch/WebFetch/TodoWrite/Task）、思考强度与模型选择
- **M3 数据面**：token 用量统计（含缓存）面板、配额卡片、设置中心
- **M4 记忆与人格**：分层记忆注入、会话结束蒸馏、记忆管理界面
- **M5 外观**：暗色默认主题、主题 JSON 导入/AI 生成、字体导入
- **M6 发布**：electron-updater + GitHub Actions Release 流水线、安装包产出
- **M7 自测交付**：Vitest 单测 + Playwright E2E + ~~子代理真实任务自测~~（用户决定跳过，待配 key 后补跑）；已完成：26 单测 + 3 联网工具实测 + 3 E2E 全绿，交付

## 7. 已确认的决策（2026-09-28）

1. pi 集成：**npm SDK + Electron utilityProcess**
2. 发布：**v1 纯本地构建**（electron-builder 本地出包）；electron-updater 集成与 GitHub Actions workflow 一并写好，但暂不创建远程仓库、不启用，建仓库后即可打开
3. 配额首批厂商：**z.ai / Moonshot / DeepSeek / Qwen(DashScope)**
4. macOS：**不签名**，README 提供 Gatekeeper 绕过说明

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| pi 版本升级 breaking change | SDK 调用集中在 agent-host 适配层；锁版本+升级清单测试 |
| 各厂商配额 API 无公开文档 | 适配器接口先行，逐家实测；不支持的厂商显示"暂不支持" |
| macOS 未签名安装包 Gatekeeper 拦截 | 文档给出一键绕过命令；后续可接 Apple 证书 |
| WebSearch 抓 Bing 结构变动 | 解析失败降级为空列表+提示，不炸会话；留有官方 API 适配口 |
