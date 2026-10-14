# Spcode Harness

以 [Pi](https://github.com/earendil-works/pi) 为引擎的 Agentic Code 桌面工作台。

```
Renderer(React 19) ←IPC→ Main(Electron) ←结构化克隆→ AgentHost(utilityProcess: pi SDK) → 各家模型 API
```

## 功能

- **聊天 / 项目双模式**：仅对话，或选择文件夹开始干活
- **计划模式**：输入框下「计划」开关，模型只读调研并输出完整计划（落盘 `~/.spcode/plans/`），批准卡确认后才恢复写工具执行，执行必建任务清单
- **完整 Agentic 工具集**：pi 内置 read/write/edit/bash/grep/find/ls + 自研 WebSearch / WebFetch / TodoWrite / AskUserQuestion / Task 子代理
- **会话标题自动生成**：模型主动命名 + harness 兜底生成双保险，不再只有首条消息截断
- **会话搜索**：Cmd+K 或侧栏搜索按钮，标题 + 正文全文检索，命中直接恢复会话
- **定时任务**：侧栏时钟按钮管理，到点自动新建会话执行指令（单次/每小时/每天/工作日/每周）
- **分层记忆**：SOUL / USER / MEMORY / 每日日志 / 项目记忆 / lessons，会话创建时注入、结束后自动蒸馏（`~/.spcode/`）
- **Token 统计**：按模型 × 会话 × 日归集，含缓存命中率与成本（`~/.spcode/usage/*.jsonl`）
- **配额卡片**：z.ai / Moonshot / DeepSeek / Qwen 余额与配额
- **思考强度**：off ~ max 七档，引擎 compat 层翻译成各家 API 的真实参数
- **外观**：默认暗色主题「雀羽 · 墨」，主题 JSON 导入 / AI 生成，本地字体导入
- **权限网关**：ask / act 双模式，危险命令（rm -rf、sudo、git reset --hard…）与对外动作（git push、发布…）永远确认
- **命令沙盒**：bash 命令在 OS 级边界内执行（macOS Seatbelt / Linux bubblewrap），写入限工作目录、敏感路径禁读、网络按域名白名单放行；详见 [docs/sandbox.md](docs/sandbox.md)
- **长程任务**：引擎自带自动压缩 / 溢出恢复 / 可中断重试，运行中可 steer 插话

## 开发

```bash
pnpm install        # 首次安装（已配 npmmirror 镜像加速 Electron 下载）
pnpm dev            # 开发模式（HMR）
pnpm test           # Vitest 单测
pnpm build          # 类型安全的生产构建
```

首次使用：设置（左下 ⚙️）里填任一厂商的 API Key，模型列表自动可用。

## 打包

```bash
pnpm --filter @spcode/desktop dist:mac    # macOS dmg + zip（arm64/x64，未签名）
pnpm --filter @spcode/desktop dist:win    # Windows nsis + zip（需在 Windows 上跑）
```

macOS 未签名包首次打开被 Gatekeeper 拦截时：

```bash
xattr -cr /Applications/Spcode.app
```

## 自动更新（待启用）

1. 建 GitHub 仓库，把 `apps/desktop/electron-builder.yml` 和 `apps/desktop/src/main/updater.ts` 里的 `TODO-OWNER`/`TODO-REPO` 改成真实值；
2. 推一个 tag：`git tag v0.1.0 && git push --tags` —— `.github/workflows/release.yml` 自动构建双平台安装包并发布 Release；
3. 应用内 electron-updater 每 4 小时轮询 Release，下载完成自动安装。

## 数据目录

```
~/.spcode/
├── settings.json      设置（主题/字体/权限模式/默认模型）
├── sessions.json      会话注册表
├── schedules.json     定时任务
├── SOUL.md USER.md MEMORY.md   分层记忆（可手改）
├── memory/            日志 / lessons / 项目记忆
├── usage/*.jsonl      token 用量流水
├── plans/             计划模式的 PLAN.md（按会话 id 存放，删会话时一并清理）
├── fonts/             导入的字体
├── agent/             pi 引擎数据（auth.json / 会话文件 / 模型目录）
└── scratch/           聊天模式工作目录
```

## 技术栈

TypeScript 全栈 · pnpm monorepo · Electron 44 + electron-vite · React 19 + Zustand + Tailwind 4 · `@earendil-works/pi-coding-agent` v0.87.1（MIT）· electron-builder / electron-updater
