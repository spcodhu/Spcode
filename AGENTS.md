# AGENTS.md · 仓库协作规则

## 提交与推送（每个功能完成后必做）

- **每个功能 / 修复完成后立即提交并 push**，不要攒一批再提；一个逻辑改动一笔提交，不相关的改动分开提。
- 提交前先验证：`pnpm typecheck`，涉及构建产物的改动再跑 `pnpm build`（都在 `apps/desktop/` 下）。
- commit message 用中文，格式：`<前缀>: <一句话主题>`，前缀从现有惯例里选：`INIT:` / `功能:` / `修复:` / `UI:` / `重构:` / `文档:` / `测试:`。
- 主题说清"做了什么"；修复类提交在 body 里写根因和关键改动点（每条一行，`- ` 开头）。
- push 到当前分支对应的远程分支；本地分支没建跟踪时用 `git push -u origin <branch>`。

## 发布策略

- 日常功能 / 修复提交一律不触发发布：不打 tag、不碰版本号，安安静静提交即可（push/PR 会自动跑 CI 的 lint+typecheck+单测；e2e 仍为手动触发）。
- 只有用户明确要求"发布版本"时才走发布流程；发布前**必须主动询问本次是测试版还是稳定版**。
- 发布动作：推进 `apps/desktop/package.json` 的 `version`（测试版加 `-beta.N` 后缀）→ 提交 → 打同名 `v*` tag → 推 tag 触发 release.yml。测试版在 GitHub 上是 Pre-release，不影响稳定版用户。
- 发布前先在本地跑 `pnpm --filter @spcode/desktop test`（2026-10 曾因改名后没跑测试导致 beta 流水线双平台挂掉）。

## 不要提交的东西

- `.finch/`（本地权限/工具状态）
- `apps/desktop/test-results/`（测试截图与报告）——该目录已在 `.gitignore`，若历史上被跟踪过需 `git rm -r --cached` 清理
- 临时验证脚本、构建产物（`out/`、`dist/`）、任何密钥/Token

## 测试纪律

- 改动 UI 文案、布局或交互结构后，必须跑 `pnpm --filter @spcode/desktop test:e2e`（至少跑 smoke）；e2e 断言一律锚定 role / placeholder / data-testid，不锚定展示文案。
- e2e 跑在临时 `SPCODE_HOME` 下，不得读写真实 `~/.spcode/`。
