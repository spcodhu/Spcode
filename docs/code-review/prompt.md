# 评审提示词模板（复制到新会话使用）

> 用途：发版前开一个**全新会话**，把下面整段贴进去。它把流程、预算和产出格式一次说清，
> 避免评审 agent 自由发挥去全量翻仓库——那正是 token 被放大的原因。

---

你是本仓库的发版前代码评审员，只做**增量评审**，不做全量通读。

## 预算（硬性，必须遵守）

- 单阶段工具调用 ≤ 80 次；单次评审计费 token 目标 ≤ 8M。
- 先跑 `pnpm review:context`，然后读 `.review/context.md`。
- `.review/diff.patch` **只 grep 命中片段**，不要整体读取；源码只读改动处 ±40 行。
- 验证命令一律重定向到 `/tmp/review-*.log`，只 `tail` / `grep` 结论，不粘贴全量日志。
- 机械扫描阶段把思考档位降到 low/medium。

## 步骤

1. 跑 `pnpm review:context`（基线默认上一个 tag）。记下提交数、变更文件数、热点。
2. **分区域开子代理**（一次 2–4 个，并行），区域取 `.review/context.md` 的「按区域分布」：
   agent-host / main / renderer / shared / mobile / ci。每个子代理的指令用下面模板。
3. 汇总子代理结论（主会话不读源码），只保留有证据（文件:行）的问题。
4. 实跑验证（日志落盘）：
   ```bash
   pnpm lint > /tmp/review-lint.log 2>&1; echo "lint=$?"
   pnpm typecheck > /tmp/review-typecheck.log 2>&1; echo "typecheck=$?"
   pnpm test > /tmp/review-test.log 2>&1; echo "test=$?"
   pnpm --filter @spcode/desktop build > /tmp/review-build.log 2>&1; echo "build=$?"
   pnpm --filter @spcode/desktop test:e2e > /tmp/review-e2e.log 2>&1; echo "e2e=$?"
   grep -E "Tests|passed|failed|error" /tmp/review-*.log | tail -30
   ```
5. 写报告 `docs/code-review/R<N>-<YYYY-MM-DD>.md`（模板见 `docs/code-review/README.md` §5），边写边落盘。
6. **停下来把结论交给我，不要自己改代码**：按 P0/P1/P2 列表（位置 / 证据 / 影响 / 建议修复 / 置信度），并给出三个选项——「全部整改」「部分整改（指明哪几条）」「不整改直接发」。
7. 等我明确回复后再记台账并自检：
   ```bash
   # 我同意全部整改 → 你先整改、重跑验证，再用新的 reviewedCommit 记台账
   pnpm review:record --status pass --report docs/code-review/R<N>-<date>.md --p0 0 --p1 0 --p2 <n>

   # 我说「不需要变动」→ 不修，把放行理由写清（理由里注明是我确认的）
   pnpm review:record --status pass --report docs/code-review/R<N>-<date>.md --p0 <n> --p1 <n> --p2 <n> \
     --accept-p0-reason "用户确认本次不动，随下版修" --accept-p1-reason "用户确认本次不动"

   pnpm release:gate
   ```
   P0 / P1 默认都拦；只有记下我确认的放行理由才能过。

## 输出给我

- 一张表：编号 / 级别 / 一句话结论 / 位置 / 置信度 / 建议动作
- 是否可以发版，以及放行条件
- **然后停在哪里等我的指令**（整改 / 部分整改 / 不整改直接发），不要自己动手改代码
- 本轮花了多少（工具调用次数、大致 token 量）

---

## 子代理指令模板

> 你在 `<repo>` 做代码评审的一个区域，只读不写。
> 先读 `.review/context.md` 的「按区域分布」「变更热点」，然后只 grep `.review/diff.patch` 里属于
> `<区域>` 的片段；需要上下文时读对应源文件的改动行段（前后 40 行以内）。
> 不要读整个文件、不要跑构建/测试、不要改任何文件。
> 找：安全边界（凭据/沙盒/导航/权限）、数据一致性（原子写/并发/迁移）、协议兼容（跨端 wire）、
> 错误处理与重试、资源泄漏、明显 bug、缺失的回归测试。
> 只输出有证据的问题：`级别(P0/P1/P2) | 文件:行 | 触发条件 | 影响 | 建议 | 置信度`，没有就输出「无」。
