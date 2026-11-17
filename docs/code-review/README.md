# 代码评审流程（发版前常态化）

> 目标：每次发布（测试版 / 稳定版）前都做一轮**增量**评审；有问题就中断发布，由用户决定是否整改。
> 历史报告：[CODE-REVIEW.md](../CODE-REVIEW.md)（R1/R2）、[CODE-REVIEW-R4.md](../CODE-REVIEW-R4.md)（R4）。

## 0. 为什么这么定：Token 花在哪

R3 那次全量评审的实测（`~/.spcode/usage` 账单 + 会话文件对账）：

| 现象 | 实测值 | 后果 |
|---|---|---|
| 单会话 635 次模型调用 | 平均上下文 **590k tokens/次** | 成本 ≈ 轮次²；越到后面单步越贵 |
| thinking 全程留在历史 | 377 个 thinking 块占全部历史 **55%** | 每轮重发，纯放大 |
| 工具调用过碎 | 756 次调用（bash 403 / read 47） | 每次调用 = 一次全上下文重放 |
| 一次性全量评审 | 基线跨度 225 提交 / 429 文件 | 只能全文件通读，diff 起不到裁剪作用 |
| 日志直读 | 单条 `pnpm test` 输出 25k 字符进历史 | 之后每轮都带着它 |

结论：**成本由「轮次 × 上下文」决定，不是由代码量决定。** 所以流程围绕两件事设计：把上下文压小、把轮次砍少。

## 1. 触发时机

| 场景 | 要求 |
|---|---|
| 每次发布前（beta / stable） | **必做**，覆盖「上一个 release tag → HEAD」 |
| 距上次评审超过 20–40 个提交 | 建议主动做一轮，避免攒成大爆炸 |
| 只改文档 / 只改测试 | 可只跑门禁 + 抽查（在台账 note 里写明） |

## 2. 六步流程

```bash
# 1) 生成增量上下文包（一次命令替代上百次探索）
pnpm review:context            # 产物在 .review/：context.md / diff.patch / meta.json
```

2. **静态审查（分区域、每区域一个子代理/新会话）**
   - 按 `.review/context.md` 的「按区域分布」逐个区域开子会话（agent-host / main / renderer / shared / mobile / ci…）。
   - 子代理只读属于自己的 diff 片段 + 必要行段，**只把结论带回主会话**（P0/P1/P2 + 证据行号）。
   - 主会话不读源码，只汇总结论。

3. **实跑验证（结论落盘，不进上下文）**

   ```bash
   pnpm lint > /tmp/review-lint.log 2>&1; echo "lint=$?"
   pnpm typecheck > /tmp/review-typecheck.log 2>&1; echo "typecheck=$?"
   pnpm test > /tmp/review-test.log 2>&1; echo "test=$?"
   pnpm --filter @spcode/desktop build > /tmp/review-build.log 2>&1; echo "build=$?"
   pnpm --filter @spcode/desktop test:e2e > /tmp/review-e2e.log 2>&1; echo "e2e=$?"
   grep -E "Tests|passed|failed|error" /tmp/review-*.log | tail -30
   ```

4. **写报告**：`docs/code-review/R<N>-<date>.md`，模板见 §5，边写边落盘，不攒到最后一次性输出。

5. **记台账**：

   ```bash
   pnpm review:record --status pass --report docs/code-review/R5-2026-11-17.md --p0 0 --p1 0 --p2 7
   ```

6. **过门禁 → 发版**：

   ```bash
   pnpm release:gate     # 本地自检；打 tag 后 release.yml 的 review-gate job 再校验一次
   ```

## 3. Token 预算（硬性）

| 项 | 上限 | 超标怎么办 |
|---|---|---|
| 单阶段工具调用 | 80 次 | 落盘结论、换新会话继续 |
| 单次评审计费 token | 8M | 缩小 `--area` 范围，分两次评审 |
| 单个源文件读取 | 只读改动处 ±40 行 | 用 `grep -n` 定位后 `read --offset/--limit` |
| 日志进入上下文 | 只允许 `tail -30` / `grep` 结果 | 重定向到 `/tmp/*.log` |
| diff 进入上下文 | 只允许 grep 命中片段 | 不整体读 `.review/diff.patch` |

另外两条习惯：机械扫描阶段把 thinking 档位降到 low/medium；评审与整改**分开两个会话**，整改不要接在评审会话后面做。

## 4. 分级与放行规则

| 级别 | 定义 | 发版 |
|---|---|---|
| P0 | 安全 / 数据损坏 / 会挂死 / 凭据泄露 | **必须修**，门禁硬拦 |
| P1 | 确定的功能 bug、明显缺口 | 默认拦；用户明确接受后写 `--accept-p1-reason` 放行 |
| P2 | 质量、性能、可维护性 | 记录即可，排期修 |
| 观察项 | 需要更多信息 | 记录，不拦 |

> 门禁只约束「有没有按流程做评审 + 有没有未闭环 P0/P1」，不替用户做技术判断。
> 用户说「先不要动」时，评审就只读、只出报告，不整改。

## 5. 报告模板

```markdown
# Spcode Harness 代码评审报告（R<N>）

> 评审日期：
> 基线：<上一 tag> → 评审提交：<sha>
> 评审方式：增量静态审查 + 实跑验证

## 0. 范围与验证
- 提交数 / 变更文件数：
- 实跑：lint / typecheck / 单测 / build / e2e 结果（命令 + 结论）

## 1. 结论摘要
- P0 = n，P1 = n，P2 = n；是否可以发版；放行条件

## 2. 问题清单
### P0-x · <标题>
- 位置：`文件:行`
- 证据 / 触发条件：
- 影响：
- 建议修复：
- 置信度：高 / 中 / 低

## 3. 值得保留的亮点（避免重构弄丢）

## 4. 与上轮结论的对照（已修 / 未修 / 新增）
```

## 6. 反模式（会直接把成本放大 10 倍）

- ❌ 从 R1 起全量通读，不看 diff。
- ❌ 一个会话从评审做到整改、再做到发版（轮次越多，单步越贵）。
- ❌ 把 `pnpm test` / 构建日志整段贴进对话。
- ❌ 反复读同一个文件确认细节（先 grep 定位再读行段）。
- ❌ 为了「看报错」再打一个 tag（先查 GitHub Annotations）。
