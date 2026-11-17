#!/usr/bin/env node
/**
 * 评审上下文打包器：把「上一个发布 tag → HEAD」的增量一次性压成两份文件，
 * 让评审者（人或 agent）读 1 个 md + 按需 grep 1 个 patch，而不是几十次探索调用。
 *
 * 为什么要有它：实测一次全量评审 635 次模型调用、平均上下文 590k tokens、
 * 账单 288M，其中 99% 是每轮重发历史的 cacheRead。上下文越小、轮次越少，
 * 成本按平方下降。本脚本把「发现变更 → 定位文件 → 读代码」压成一次读取。
 *
 * 用法：
 *   node scripts/review-context.mjs                 # 默认 base = 上一个 tag
 *   node scripts/review-context.mjs --base v0.1.0-beta.30
 *   node scripts/review-context.mjs --budget 200000 # 内嵌 diff 的字符上限
 *   node scripts/review-context.mjs --area src/main # 只看某个目录
 *
 * 产物（均在 .review/，已 gitignore）：
 *   context.md    结构化摘要（先读这一份）
 *   diff.patch    完整 diff（只 grep，不要整体读）
 *   meta.json     base/head/统计，供 review-record 复用
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const cwd = process.cwd();
const argv = process.argv.slice(2);

function arg(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return argv[i + 1] ?? fallback;
}

function git(...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function tryGit(...args) {
  try {
    return git(...args);
  } catch {
    return "";
  }
}

const lastTag = tryGit("describe", "--tags", "--abbrev=0").trim();
const base = arg("base", lastTag);
if (!base) {
  console.error("找不到上一个 tag，也没有传 --base；增量评审必须有基线。");
  process.exit(1);
}

const area = arg("area", "");
const budget = Number(arg("budget", "40000"));
const head = git("rev-parse", "HEAD").trim();
const headShort = head.slice(0, 7);
const baseShort = tryGit("rev-parse", "--short", base).trim() || base;

const range = `${base}..HEAD`;
const commits = tryGit("log", "--oneline", "--no-decorate", range)
  .trim()
  .split("\n")
  .filter(Boolean);

const numstat = tryGit("diff", "--numstat", range)
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [add, del, file] = line.split("\t");
    return { file, add: Number(add) || 0, del: Number(del) || 0 };
  })
  .filter((f) => !area || f.file.includes(area));

if (numstat.length === 0) {
  console.log(`基线 ${base} 与 HEAD 之间没有代码变更（或 --area 过滤后为空）。`);
  process.exit(0);
}

const totalAdd = numstat.reduce((n, f) => n + f.add, 0);
const totalDel = numstat.reduce((n, f) => n + f.del, 0);
const changed = numstat
  .slice()
  .sort((a, b) => b.add + b.del - (a.add + a.del))
  .map((f) => ({ ...f, size: f.add + f.del }));

const extraArgs = area ? ["--", area] : [];
const patch = tryGit("diff", "--find-renames", range, ...extraArgs);
const untracked = tryGit("ls-files", "--others", "--exclude-standard")
  .trim()
  .split("\n")
  .filter(Boolean);

/** 变更文件按区域归类，评审时按区域分批、每批一个子代理/会话 */
const AREAS = [
  ["agent-host", "apps/desktop/src/agent-host"],
  ["main", "apps/desktop/src/main"],
  ["preload", "apps/desktop/src/preload"],
  ["renderer", "apps/desktop/src/renderer"],
  ["mobile", "apps/mobile"],
  ["shared", "packages/shared"],
  ["ui", "packages/ui"],
  ["ci", ".github"],
  ["e2e", "apps/desktop/e2e"],
  ["tests", "apps/desktop/test"],
  ["docs", "docs"],
];
const buckets = new Map();
for (const f of changed) {
  const hit = AREAS.find(([, prefix]) => f.file.startsWith(prefix));
  const key = hit ? hit[0] : "其他";
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(f);
}

/** 就近单测启发式：src/main/foo.ts → test/foo*.test.ts */
const testFiles = new Set(
  tryGit("ls-files", "apps/desktop/test")
    .split("\n")
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => f.split("/").pop().replace(".test.ts", "")),
);
const withoutTests = changed
  .filter((f) => f.file.endsWith(".ts") || f.file.endsWith(".tsx"))
  .filter((f) => !f.file.includes("/test/") && !f.file.includes("/e2e/"))
  .filter((f) => {
    const name = f.file.split("/").pop().replace(/\.(ts|tsx)$/, "");
    if (testFiles.has(name)) return false;
    return ![...testFiles].some((t) => t.startsWith(name) || name.startsWith(t.replace(/-.*$/, "")));
  })
  .map((f) => f.file);

/** 内嵌 diff 到预算为止（大文件只列热点，用 grep 命中再读片段）
 * 测试/文档与纯删除默认不内嵌：它们体量大、信号低，需要时从 diff.patch 里 grep。 */
const SKIP_EMBED = /\/(e2e|test|tests)\//;
const skipped = [];
let embedded = "";
let embeddedCount = 0;
let truncated = false;
for (const f of changed) {
  const isDelete = f.add === 0;
  const lowSignal = isDelete || SKIP_EMBED.test(f.file) || f.file.startsWith("docs/") || f.file === "pnpm-lock.yaml";
  if (lowSignal && !argv.includes("--all")) {
    skipped.push({ file: f.file, reason: isDelete ? "纯删除" : "测试/文档/锁文件" });
    continue;
  }
  if (f.size < 14 && changed.length > 60) continue; // 噪音：单行改动不占预算
  const piece = tryGit("diff", "--find-renames", range, "--", f.file);
  if (embedded.length + piece.length > budget) {
    truncated = true;
    skipped.push({ file: f.file, reason: "超出内嵌预算" });
    continue;
  }
  embedded += piece;
  embeddedCount += 1;
}

const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
const md = `# 评审上下文包 · ${baseShort}..${headShort}

> 生成时间：${stamp}
> 基线：\`${base}\` → HEAD：\`${head}\`
> 提交 ${commits.length} 个，变更文件 ${changed.length} 个，+${totalAdd} / -${totalDel}
> 完整 diff：\`.review/diff.patch\`（${Math.round(patch.length / 1024)}KB，约 ${Math.round(patch.length / 4 / 1000)}k tokens）

## 使用纪律（省 token 的关键，不要跳读）

- 先读本文件，不要先在仓库里乱翻。
- 需要实现细节时，\`grep -n "<符号或错误码>" .review/diff.patch\` 定位，只读命中片段；
  **不要把 diff.patch 整体读进上下文**。
- 单个文件要看全文时，只读改动函数附近的行段（read 的 offset/limit），不要整文件通读。
- 实跑验证一律重定向到文件（见文末），只 \`tail\` / \`grep\` 结论，不粘贴全量日志。
- 预算：单阶段 ≤80 次工具调用；超出就换会话、把结论先落盘。
- 分批：按下面「按区域分布」逐个区域开子会话，只把结论带回主会话。

## 提交列表（${commits.length}）

${commits
  .slice(0, 300)
  .map((c) => `- ${c}`)
  .join("\n")}${commits.length > 300 ? `\n- …其余 ${commits.length - 300} 个省略` : ""}

## 变更热点（按改动行数）

| 文件 | + | - |
|---|---|---|
${changed
  .slice(0, 40)
  .map((f) => `| \`${f.file}\` | ${f.add} | ${f.del} |`)
  .join("\n")}
${changed.length > 40 ? `\n其余 ${changed.length - 40} 个文件见 \`git diff --numstat\`。` : ""}

## 按区域分布

${[...buckets.entries()]
  .map(([key, files]) => `- **${key}**（${files.length}）：${files.map((f) => `\`${f.file.split("/").pop()}\``).join("、")}`)
  .join("\n")}

## 没有就近单测的源文件（优先人工看）

${withoutTests.length === 0 ? "（无）" : withoutTests.map((f) => `- \`${f}\``).join("\n")}

## 未跟踪文件（评审前确认是否应入库）

${untracked.length === 0 ? "（无）" : untracked.map((f) => `- \`${f}\``).join("\n")}

## 验证命令（日志落盘，只读结论）

\`\`\`bash
pnpm lint > /tmp/review-lint.log 2>&1; echo "lint=$?"
pnpm typecheck > /tmp/review-typecheck.log 2>&1; echo "typecheck=$?"
pnpm test > /tmp/review-test.log 2>&1; echo "test=$?"
pnpm --filter @spcode/desktop build > /tmp/review-build.log 2>&1; echo "build=$?"
pnpm --filter @spcode/desktop test:e2e > /tmp/review-e2e.log 2>&1; echo "e2e=$?"
# 只看结论：grep -E "Tests|passed|failed|error" /tmp/review-*.log | tail -30
\`\`\`

## Diff（内嵌 ${embeddedCount}/${changed.length} 个文件${truncated ? "，其余请 grep .review/diff.patch" : ""}）

${skipped.length > 0 ? `未内嵌：${skipped.map((s) => `\`${s.file}\`（${s.reason}）`).join("、")}` : ""}

\`\`\`diff
${embedded}
\`\`\`
`;

mkdirSync(join(cwd, ".review"), { recursive: true });
writeFileSync(join(cwd, ".review", "context.md"), md, "utf8");
writeFileSync(join(cwd, ".review", "diff.patch"), patch, "utf8");
writeFileSync(
  join(cwd, ".review", "meta.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      base,
      baseShort,
      head,
      headShort,
      commits: commits.length,
      changedFiles: changed.length,
      insertions: totalAdd,
      deletions: totalDel,
      patchBytes: Buffer.byteLength(patch),
      contextTokensEstimate: Math.round(md.length / 4),
      untracked,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log("评审上下文已生成：");
console.log(`  .review/context.md   ${Math.round(md.length / 1024)}KB（约 ${Math.round(md.length / 4 / 1000)}k tokens）`);
console.log(`  .review/diff.patch   ${Math.round(patch.length / 1024)}KB（只 grep，不要整体读）`);
console.log(`  ${commits.length} 个提交 / ${changed.length} 个文件 / +${totalAdd} -${totalDel}`);
console.log("下一步：读 .review/context.md，按区域分批评审，结论写入 docs/code-review/R<N>-<date>.md，再跑 pnpm review:record。");
