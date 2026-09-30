# AGENTS.md · 仓库协作规则

## 提交与推送（每个功能完成后必做）

- **每个功能 / 修复完成后立即提交并 push**，不要攒一批再提；一个逻辑改动一笔提交，不相关的改动分开提。
- 提交前先验证：`pnpm typecheck`，涉及构建产物的改动再跑 `pnpm build`（都在 `apps/desktop/` 下）。
- commit message 用中文，格式：`<前缀>: <一句话主题>`，前缀从现有惯例里选：`INIT:` / `功能:` / `修复:` / `UI:` / `重构:` / `文档:` / `测试:`。
- 主题说清"做了什么"；修复类提交在 body 里写根因和关键改动点（每条一行，`- ` 开头）。
- push 到当前分支对应的远程分支；本地分支没建跟踪时用 `git push -u origin <branch>`。

## 不要提交的东西

- `.finch/`（本地权限/工具状态）
- `apps/desktop/test-results/`（测试截图与报告）——该目录已在 `.gitignore`，若历史上被跟踪过需 `git rm -r --cached` 清理
- 临时验证脚本、构建产物（`out/`、`dist/`）、任何密钥/Token

## 测试纪律

- 改动 UI 文案、布局或交互结构后，必须跑 `pnpm --filter @spcode/desktop test:e2e`（至少跑 smoke）；e2e 断言一律锚定 role / placeholder / data-testid，不锚定展示文案。
- e2e 跑在临时 `SPCODE_HOME` 下，不得读写真实 `~/.spcode/`。
