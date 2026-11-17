#!/usr/bin/env node
/**
 * 评审台账写入器：把「本轮评审覆盖到哪个提交、结论如何」记到
 * docs/code-review/latest.json，发版门禁（release:gate）只认这份台账。
 *
 * 用法：
 *   node scripts/review-record.mjs --status pass --report docs/code-review/R5-2026-11-17.md --p0 0 --p1 0 --p2 7
 *   node scripts/review-record.mjs --status blocked --report ... --p1 2
 *   node scripts/review-record.mjs --status pass --report ... --p1 2 --accept-p1-reason "用户确认本次不动"
 *   node scripts/review-record.mjs --status pass --report ... --p0 1 --accept-p0-reason "用户确认本次不动，随下版修"
 *
 * 设计约定：
 * - 评审发现问题时**先交用户决策**，用户未同意整改就不得改代码（见 docs/code-review/README.md §4.1）；
 * - P0 / P1 默认都不允许带病发版，只有显式记录「用户已确认本次不动」的原因才放行；
 * - 放行理由字符串是用户决策的唯一凭据：没拿到用户回复就不要写；
 * - reviewedCommit 必须等于发布提交，否则门禁要求增量复评（这正是降本的关键）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
const metaPath = resolve(cwd, ".review", "meta.json");
const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null;

const status = arg("status");
if (!["pass", "blocked", "pending"].includes(status)) {
  console.error("--status 必须是 pass | blocked | pending");
  process.exit(1);
}

const head = arg("commit", git("rev-parse", "HEAD"));
const baseline = arg("base", meta?.base ?? arg("baseline", ""));
const report = arg("report", "");
const p0 = Number(arg("p0", "0"));
const p1 = Number(arg("p1", "0"));
const p2 = Number(arg("p2", "0"));
const acceptP1Reason = arg("accept-p1-reason", "");
const acceptP0Reason = arg("accept-p0-reason", "");
const note = arg("note", "");
const reviewer = arg("reviewer", "agent");

if (!report) {
  console.error("必须用 --report 指定本轮报告路径（docs/code-review/R<N>-<date>.md）。");
  process.exit(1);
}
if (!existsSync(resolve(cwd, report))) {
  console.error(`报告文件不存在：${report}`);
  process.exit(1);
}
if (status === "pass" && p0 > 0 && !acceptP0Reason) {
  console.error(
    "存在未闭环 P0：默认不允许发版。先整改；用户明确说本次不动时，补 --accept-p0-reason \"<原因>\" 后再记录。",
  );
  process.exit(1);
}
if (status === "pass" && p1 > 0 && !acceptP1Reason) {
  console.error(
    "存在未闭环 P1：默认不允许发版。先整改；用户明确说本次不动时，补 --accept-p1-reason \"<原因>\" 后再记录。",
  );
  process.exit(1);
}
if (status !== "pass" && (p0 > 0 || p1 > 0) === false && note === "") {
  // pending/blocked 允许无数字，但提示一句，避免误记为「零问题却被拦」。
  console.warn("提示：非 pass 状态但没有 P0/P1 计数，建议用 --note 说明原因。");
}

const ledger = {
  schema: 1,
  status,
  reviewedCommit: head,
  baseline,
  date: new Date().toISOString().slice(0, 10),
  reviewer,
  report,
  findings: { p0, p1, p2 },
  openP0Accepted: p0 > 0 && acceptP0Reason ? { count: p0, reason: acceptP0Reason } : null,
  openP1Accepted: p1 > 0 && acceptP1Reason ? { count: p1, reason: acceptP1Reason } : null,
  note,
};

writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
console.log(`已写入 ${ledgerPath}`);
console.log(`  状态=${status} 提交=${head.slice(0, 7)} 基线=${baseline || "(未记录)"} P0=${p0} P1=${p1} P2=${p2}`);
if (acceptP0Reason) console.log(`  ⚠ P0 放行（用户确认）：${acceptP0Reason}`);
if (acceptP1Reason) console.log(`  ⚠ P1 放行（用户确认）：${acceptP1Reason}`);
console.log("下一步：提交这份台账（连同报告），然后 pnpm release:gate 自检；打 tag 后 CI 会再校验一次。");
