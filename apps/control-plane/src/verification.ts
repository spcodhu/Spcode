import { execFile } from "node:child_process";
import type { WorkerTestEvidence } from "@spcode/shared/superagent";
import { workerEnvironment } from "./git-workspace.js";

/** 控制面独立复跑批准计划中的命令；不使用 Worker 自报的退出码代替真实验证。 */
export function runVerification(command: string, cwd: string, timeoutMs = 10 * 60_000): Promise<WorkerTestEvidence> {
  const startedAt = Date.now();
  const executable = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      { cwd, env: workerEnvironment(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code =
          typeof (error as { code?: unknown } | null)?.code === "number"
            ? (error as unknown as { code: number }).code
            : error
              ? 1
              : 0;
        const output = `${stdout}${stderr}`.slice(-64_000);
        resolve({
          command,
          status: code === 0 ? "passed" : "failed",
          exitCode: code,
          durationMs: Date.now() - startedAt,
          ...(output ? { output } : {}),
        });
      },
    );
  });
}
