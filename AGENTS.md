# AGENTS.md · 仓库协作规则

## 提交与推送（每个功能完成后必做）

- **每个功能 / 修复完成后立即提交并 push**，不要攒一批再提；一个逻辑改动一笔提交，不相关的改动分开提。
- 提交前先验证，**检查项必须与 `ci.yml` 对齐**（在仓库根目录跑）：`pnpm lint && pnpm typecheck && pnpm test`；涉及构建产物的改动再跑 `pnpm build`（在 `apps/desktop/` 下）。lint / typecheck 不通过就不要 commit。
  - 反例（2026-11-17）：改动只在 `apps/desktop` 里跑了 typecheck 和单测就提交并 push，新测试文件违反 biome 的 import 顺序与行尾换行，`ci.yml` 在 install 之后第一步 `pnpm lint` 用了 40 秒就变红。只验一部分检查项等于没验。
- commit message 用中文，格式：`<前缀>: <一句话主题>`，前缀从现有惯例里选：`INIT:` / `功能:` / `修复:` / `UI:` / `重构:` / `文档:` / `测试:`。
- 主题说清"做了什么"；修复类提交在 body 里写根因和关键改动点（每条一行，`- ` 开头）。
- push 到当前分支对应的远程分支；本地分支没建跟踪时用 `git push -u origin <branch>`。

## 发布策略

- **硬规则：任何 agent（含 Qoder / Cursor 这类第三方工具）不得自行执行 `git tag`、不得改 `apps/desktop/package.json` 的 `version`、不得触发 release 工作流**——打 tag 就等于发版。当前会话没有用户明确要求「发布版本」时，这些动作一律不做，也不「顺手」做；本地 `pre-push` 钩子会直接拒绝推送 `refs/tags/*`（见下方「本地钩子」）。
- 日常功能 / 修复提交一律不触发发布：不打 tag、不碰版本号，安安静静提交即可（push/PR 会自动跑 CI 的 lint+typecheck+单测；e2e 仍为手动触发）。
- 只有用户明确要求"发布版本"时才走发布流程；发布前**必须主动询问本次是测试版还是稳定版**。
- 发布动作：推进 `apps/desktop/package.json` 的 `version`（测试版加 `-beta.N` 后缀）→ **过评审门禁** → 提交 → 打同名 `v*` tag → 推 tag 触发 release.yml。推 tag 时本地 `pre-push` 钩子会拦截，需要显式放行：`SPCODE_ALLOW_TAG_PUSH=1 git push origin <tag>`。release.yml 统一 `prerelease: false`，最新构建始终占 GitHub Latest 位，beta 与稳定版只靠版本号后缀区分。
  - 提交顺序：代码与版本号先提交，评审覆盖那个提交（`reviewedCommit`）；报告与台账再作为一个只改 `docs/code-review/**` 的提交落在后面。门禁显式允许这段尾巴，但中间只要动了代码/测试就必须重新增量评审。
- **发版前评审是硬门禁**（测试版/稳定版都算）：
  - 流程与 token 预算见 [docs/code-review/README.md](docs/code-review/README.md)：`pnpm review:context` → 分区域评审（子代理/新会话）→ 实跑验证日志落盘 → 写 `docs/code-review/R<N>-<date>.md` → `pnpm review:record` 记台账。
  - 基线固定是**上一个 release tag**，只审增量，不做全量通读；评审与整改分两个会话。
  - **评审阶段只读**：绝不自行整改、不顺手“修个小的”。发现问题先把 P0/P1/P2（位置、证据、影响、建议修复、置信度）交给用户，并给出「整改 / 部分整改 / 不整改直接发」三个选项。
  - **未获得用户明确同意前不得改任何代码**；用户说「不需要变动」时就不修，直接记台账并发版。用户未回复就先中断发布，不要自己决定。
  - 用户同意整改后：改完重跑验证并重新记台账；未修项逐条写 `--accept-p0-reason` / `--accept-p1-reason`（理由写清是用户确认本次不动）；P0/P1 默认都拦，只有这两类放行理由能过。
  - `pnpm release:gate` 本地自检；release.yml 的 `review-gate` job 会用 tag 指向的提交再校验一次，台账对不上直接失败（不会打包）。
- 更新公告：每次发布（正式版/测试版都算）必须先过一遍自上一个版本 tag 以来的全部 Git 提交（`git log <上一tag>..HEAD`），据此拟一份详细的中文更新公告——按新功能/优化/修复分组，说清用户可感知的变化与配置入口，必要时先给用户审查确认或由用户自己出具。公告要落到 GitHub Release 正文：打附注 tag 时带上（`git tag -a --cleanup=verbatim -F <tag> <公告文件>`；**必须保留 `verbatim`**，否则 Git 会把 `##` 分组标题当注释删掉）；release.yml 的 publish 阶段会自动把公告 prepend 到自动生成的 What's Changed 之前，不再单独跑第二条公告工作流。
- 发布前先在本地跑 `pnpm --filter @spcode/desktop test`（2026-10 曾因改名后没跑测试导致 beta 流水线双平台挂掉）。
- **发布失败先查 GitHub Annotations，禁止仅为查看报错另发新版本**：release.yml 的 Test 已固定使用 `vitest run --reporter=default --reporter=github-actions`，失败用例会写入公开 Annotations，不要只盯着末尾的 `Process completed with exit code 1`。
  - 先通过 `GET https://api.github.com/repos/spcodhu/Spcode/actions/runs/<RUN_ID>/jobs` 找到失败的 `JOB_ID`。
  - 再通过 `GET https://api.github.com/repos/spcodhu/Spcode/check-runs/<JOB_ID>/annotations` 读取失败文件、用例和断言详情。公开日志 API 可能因权限返回 403，但 Annotations 仍可公开读取，不要为了拿日志专门再打一个 beta tag。
  - 后续先修复根因并跑完整本地验证；只有准备重新发布时才另起 beta 号，失败 tag 不移动。

## 本地钩子（新克隆 / 新机器必做一次）

- `pnpm hooks:install`（等价于 `git config core.hooksPath .githooks && chmod +x .githooks/pre-push`）启用 `pre-push`，它做两件事：
  - **拒绝推送 `refs/tags/*`**：确认要发版时用 `SPCODE_ALLOW_TAG_PUSH=1 git push origin <tag>` 显式放行；
  - **推送前跑 `pnpm lint`**，不通过直接中止推送（`node_modules` 缺失时跳过并提示，先 `pnpm install`）。
- 钩子只在本机生效，不替代 CI：它拦的是「推之前」，`review-gate` 与 Test 仍在 release.yml 里兜底。

## 不要提交的东西

- `.finch/`（本地权限/工具状态）
- `apps/desktop/test-results/`（测试截图与报告）——该目录已在 `.gitignore`，若历史上被跟踪过需 `git rm -r --cached` 清理
- 临时验证脚本、构建产物（`out/`、`dist/`）、任何密钥/Token

## 测试纪律

- 改动 UI 文案、布局或交互结构后，必须跑 `pnpm --filter @spcode/desktop test:e2e`；e2e 断言一律锚定 role / placeholder / data-testid，不锚定展示文案。
- **E2E 只放行「必须真跑 Electron」的断言**（主进程/窗口行为、真实落盘、跨重启、主进程文件映射、宿主联调）；纯展示、纯计算、纯 CSS 行为由 `apps/desktop/test/*.test.ts` 覆盖。
- 现状：12 个 spec / 30 条用例，全量约 1 分钟。新增 E2E 前先证明单测覆盖不了，并复用手头 spec 的 seed/启动方式，不要让用例数重新进入只增不减的状态。
- e2e 的 TS 类型由 `tsconfig.e2e.json` 纳入 `pnpm typecheck`；改完先跑 typecheck 再跑 e2e（e2e 不会自动构建，源码改了要先 `pnpm --filter @spcode/desktop build`）。
- e2e 跑在临时 `SPCODE_HOME` 下，不得读写真实 `~/.spcode/`。
