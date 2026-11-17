#!/usr/bin/env node
/**
 * 发版门禁：打 tag 前（本地）与 release.yml 里（CI）各校验一次评审台账，
 * 让「每次发版前都做一次增量评审，有问题就中断发布」变成机器可执行的规则。
 *
 * 通过条件（全部满足）：
 *   1. docs/code-review/latest.json 存在且 schema 合法；
 *   2. status === "pass"；
 *   3. reviewedCommit === 目标提交（默认 HEAD）；
 *   4. findings.p0 === 0；
 *   5. findings.p1 === 0，或 openP1Accepted 已记录用户确认接受的 count 与原因；
 *   6. report 指向的报告文件存在。
 *
 * 用法：
 *   node scripts/release-gate.mjs                 # 本地：校验 HEAD
 *   node scripts/release-gate.mjs --commit <sha>  # CI：校验 tag 指向的提交
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

const ledgerPath = resolve(cwd, "docs", "code-review", "latest.json");
const target = arg("commit") || git("rev-parse", "HEAD");

function fail(lines) {
  console.error(`\n✖ 发版门禁未通过（目标提交 ${target.slice(0, 7)}）\n`);
  for (const line of lines) console.error(`  - ${line}`);
  console.error(`
修复方式：
  1) pnpm review:context                # 生成增量评审上下文包
  2) 按 docs/code-review/README.md 分阶段评审，报告写到 docs/code-review/R<N>-<date>.md
  3) pnpm review:record --status pass --report <报告> --p0 0 --p1 0 --p2 <n>
     有 P1 但用户决定放行时追加：--accept-p1-reason "<原因>"
  4) 提交台账与报告后重新打 tag
`);
  process.exit(1);
}

if (!existsSync(ledgerPath)) {
  fail([
    "缺少评审台账 docs/code-review/latest.json",
    "本次提交尚未做过评审记录（新流程首次发版也需要记录一轮）",
  ]);
}

let ledger;
try {
  ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
} catch (error) {
  fail([`台账无法解析：${error.message}`]);
}

if (argv.includes("--print")) {
  console.log(JSON.stringify(ledger, null, 2));
}

const problems = [];
if (ledger.schema !== 1) problems.push(`台账 schema 必须为 1，当前为 ${ledger.schema}`);
if (ledger.status !== "pass") problems.push(`评审结论不是 pass（当前 ${ledger.status}）`);
if (!ledger.reviewedCommit || ledger.reviewedCommit !== target) {
  const behind = ledger.reviewedCommit
    ? (() => {
        try {
          return Number(git("rev-list", "--count", `${ledger.reviewedCommit}..${target}`));
        } catch {
          return null;
        }
      })()
    : null;
  problems.push(
    `台账评审提交 ${ledger.reviewedCommit?.slice(0, 7) ?? "(空)"} ≠ 目标提交 ${target.slice(0, 7)}` +
      (behind ? `；中间还有 ${behind} 个提交需要增量复评` : ""),
  );
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
  if (!existsSync(resolve(cwd, ledger.report))) problems.push(`台账引用的报告不存在：${ledger.report}`);
} else {
  problems.push("台账缺少 report 字段");
}

if (problems.length > 0) fail(problems);

console.log("✔ 发版门禁通过");
console.log(`  提交 ${target.slice(0, 7)} · 基线 ${ledger.baseline || "(未记录)"} · 报告 ${ledger.report}`);
console.log(`  结论 P0=${p0} P1=${p1} P2=${ledger.findings?.p2 ?? 0}`);
