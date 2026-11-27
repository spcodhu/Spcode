import type { PlanRevision, WorkerWorkReport } from "@spcode/shared/superagent";
import type { GitDiffSnapshot, GitWorkspace, GitWorkspaceManager } from "./git-workspace.js";
import { runVerification } from "./verification.js";

export interface VerifiedCommit {
  sha: string;
  diff: GitDiffSnapshot;
  report: WorkerWorkReport;
}

/** 节点与本地 Manager 共用的确定性验证/commit；数据库状态由各自调用方处理。 */
export async function verifyAndCommitWorkspace(
  git: GitWorkspaceManager,
  workspace: GitWorkspace,
  plan: PlanRevision,
  report: WorkerWorkReport,
): Promise<VerifiedCommit> {
  const tests = [] as WorkerWorkReport["tests"];
  for (const command of plan.verification) tests.push(await runVerification(command, workspace.worktreePath));
  const verifiedReport = { ...report, tests };
  if (tests.length === 0 || tests.some((test) => test.status !== "passed")) {
    const failed = tests.find((test) => test.status !== "passed");
    const error = new Error(
      `批准计划中的验证命令失败：${failed?.command ?? "无验证命令"} exit=${failed?.exitCode ?? "-"} ${failed?.output?.slice(0, 500) ?? ""}`,
    );
    Object.assign(error, { report: verifiedReport, code: "VERIFICATION_FAILED" });
    throw error;
  }
  const committed = await git.commit(workspace, report.commitMessage ?? "功能: 完成工作项");
  return { sha: committed.sha, diff: committed.diff, report: verifiedReport };
}
