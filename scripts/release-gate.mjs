#!/usr/bin/env node
/**
 * 发版门禁：打 tag 前（本地）与 release.yml 里（CI）各校验一次评审台账，
 * 让「每次发版前都做一次增量评审，有问题就中断发布」变成机器可执行的规则。
 *
 * 通过条件（全部满足）：
 *   1. docs/code-review/latest.json 存在且 schema 合法（默认读**目标提交**里的版本，CI 与本地同一语义）；
 *   2. status === "pass"；
 *   3. reviewedCommit 覆盖目标提交：要么完全相等，要么两者的增量**只改评审元数据**
 *      （docs/code-review/**）。评审结论必须在提交之后才能落盘，完全相等不现实；
 *      但只允许台账/报告这几步尾巴，任何产品/测试代码改动都要求重新增量评审；
 *   4. findings.p0 === 0；
 *   5. findings.p1 === 0，或 openP1Accepted 已记录用户确认接受的 count 与原因；
 *   6. report 指向的报告文件存在。
 *
 * 用法：
 *   node scripts/release-gate.mjs                 # 本地：校验 HEAD
 *   node scripts/release-gate.mjs --commit <sha>  # CI：校验 tag 指向的提交
 *   node scripts/release-gate.mjs --worktree      # 本地：读工作区台账（提交前的预览自检）
 *   node scripts/release-gate.mjs --print         # 只打印台账
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const cwd = process.cwd();
const argv = process.argv.slice(2);

function arg(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return argv[i + 1] ?? fallback;
}

function git(...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const ledgerRel = "docs/code-review/latest.json";
const ledgerPath = resolve(cwd, ledgerRel);
/** 目标提交归一成 40 位 sha：传 HEAD / 分支名也能比，且避开符号引用恒等的坑 */
const target = git("rev-parse", "--verify", `${arg("commit") || "HEAD"}^{commit}`);
const useWorktree = argv.includes("--worktree");

function fail(lines) {
  console.error(`\n✖ 发版门禁未通过（目标提交 ${target.slice(0, 7)}）\n`);
  for (const line of lines) console.error(`  - ${line}`);
  console.error(`
修复方式：
  1) pnpm review:context                # 生成增量评审上下文包
  2) 按 docs/code-review/README.md 分阶段评审，报告写到 docs/code-review/R<N>-<date>.md
  3) pnpm review:record --status pass --report <报告> --p0 0 --p1 0 --p2 <n>
     有 P1 但用户决定放行时追加：--accept-p1-reason "<原因>"
  4) 提交报告与台账（这一步本身不算产品改动），再打 tag：门禁只允许
     reviewedCommit..tag 之间是 docs/code-review/** 的尾巴
`);
  process.exit(1);
}

/** 台账默认取目标提交里的版本（CI 与本地同一语义）；--worktree 时读工作区。 */
function readLedger() {
  if (!useWorktree) {
    try {
      return { text: git("show", `${target}:${ledgerRel}`), from: `提交 ${target.slice(0, 7)}` };
    } catch (error) {
      const message = String(error?.stderr ?? error?.message ?? error);
      if (/does not exist|exists on disk, but not in|path .* not in/i.test(message)) {
        fail([`目标提交 ${target.slice(0, 7)} 里没有 ${ledgerRel}`, "台账与报告必须随发版提交一起提交"]);
      }
      fail([
        `无法从目标提交读取台账：${message.split("\n")[0]}`,
        "CI 上是浅克隆时，请给 actions/checkout 配 fetch-depth: 0",
      ]);
    }
  }
  if (!existsSync(ledgerPath)) fail(["工作区没有评审台账 docs/code-review/latest.json"]);
  return { text: readFileSync(ledgerPath, "utf8"), from: "工作区（--worktree）" };
}

let ledger;
const ledgerSource = readLedger();
try {
  ledger = JSON.parse(ledgerSource.text);
} catch (error) {
  fail([`台账无法解析：${error.message}`]);
}

if (argv.includes("--print")) {
  console.log(JSON.stringify(ledger, null, 2));
}

/** reviewedCommit..target 之间是否只有评审元数据（台账/报告）的提交尾巴。 */
function metaOnlyTail(from) {
  try {
    git("merge-base", "--is-ancestor", from, target);
  } catch {
    return { ok: false, detail: `评审提交不是目标提交的祖先，或本地仓库历史不足（浅克隆）` };
  }
  let files;
  try {
    // -z：非 ASCII 路径默认会被加引号转义，startsWith("docs/code-review/") 就会漏判
    files = git("diff", "--name-only", "-z", from, target).split("\0").filter(Boolean);
  } catch (error) {
    return { ok: false, detail: `无法计算增量：${String(error?.message ?? error).split("\n")[0]}` };
  }
  const outside = files.filter((file) => !file.startsWith("docs/code-review/"));
  if (outside.length > 0) {
    return {
      ok: false,
      detail: `评审提交之后的增量改了非评审文件（${outside.slice(0, 5).join("、")}${outside.length > 5 ? " 等" : ""}），需要重新增量评审`,
    };
  }
  return { ok: true, detail: "" };
}

const problems = [];
if (ledger.schema !== 1) problems.push(`台账 schema 必须为 1，当前为 ${ledger.schema}`);
if (ledger.status !== "pass") problems.push(`评审结论不是 pass（当前 ${ledger.status}）`);
if (!ledger.reviewedCommit) {
  problems.push("台账缺少 reviewedCommit（本轮评审覆盖到哪个提交）");
} else if (typeof ledger.reviewedCommit !== "string" || !/^[0-9a-f]{7,40}$/i.test(ledger.reviewedCommit)) {
  problems.push(`台账 reviewedCommit 不是提交 sha：${String(ledger.reviewedCommit)}`);
} else {
  // 符号引用/短 sha 统一展开成完整 sha 再比，避免 HEAD 这类引用恒等误放行
  let reviewed = "";
  try {
    reviewed = git("rev-parse", "--verify", `${ledger.reviewedCommit}^{commit}`);
  } catch {
    problems.push(`台账 reviewedCommit 在本地仓库里不存在：${ledger.reviewedCommit.slice(0, 7)}`);
  }
  if (reviewed && reviewed !== target) {
    // 评审结论只能在提交之后落盘，因此允许「只提交台账/报告」的尾巴；产品代码动过就不行。
    const tail = metaOnlyTail(reviewed);
    if (!tail.ok) {
      problems.push(`台账评审提交 ${reviewed.slice(0, 7)} ≠ 目标提交 ${target.slice(0, 7)}：${tail.detail}`);
    }
  }
}

const p0 = Number(ledger.findings?.p0 ?? Number.NaN);
const p1 = Number(ledger.findings?.p1 ?? Number.NaN);
if (!Number.isFinite(p0) || !Number.isFinite(p1)) {
  problems.push("台账 findings.p0 / findings.p1 缺失或不是数字");
} else {
  if (p0 > 0) problems.push(`仍有 ${p0} 个未闭环 P0`);
  if (p1 > 0) {
    const accepted = ledger.openP1Accepted;
    const acceptedOk = accepted && accepted.count === p1 && String(accepted.reason ?? "").trim().length > 0;
    if (!acceptedOk) problems.push(`仍有 ${p1} 个未闭环 P1，且没有用户确认接受的记录`);
    else console.warn(`⚠ 放行 ${p1} 个 P1（用户确认：${accepted.reason}）`);
  }
}

if (ledger.report) {
  if (useWorktree) {
    if (!existsSync(resolve(cwd, ledger.report))) problems.push(`台账引用的报告不存在：${ledger.report}`);
  } else {
    try {
      git("cat-file", "-e", `${target}:${ledger.report}`);
    } catch {
      problems.push(`目标提交里没有台账引用的报告：${ledger.report}`);
    }
  }
} else {
  problems.push("台账缺少 report 字段");
}

if (problems.length > 0) fail(problems);

console.log("✔ 发版门禁通过");
console.log(`  提交 ${target.slice(0, 7)} · 台账来源 ${ledgerSource.from}`);
console.log(`  基线 ${ledger.baseline || "(未记录)"} · 报告 ${ledger.report}`);
console.log(`  结论 P0=${p0} P1=${p1} P2=${ledger.findings?.p2 ?? 0}`);
