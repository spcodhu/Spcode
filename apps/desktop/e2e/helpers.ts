/**
 * e2e 公共启动助手（评审 P1-7）：
 * 每个测试用临时目录作为 SPCODE_HOME，隔离开发者真实的 ~/.spcode/ 数据。
 * utilityProcess（agent-host）默认继承主进程 env，隔离随之传导到宿主。
 * user-data-dir 同步隔离：单实例锁（P0-5）以 userData 为键，
 * 不隔离时本机正在运行的 dev/生产实例会让 e2e 启动即退出。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, _electron as electron } from "@playwright/test";

export const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function launchApp(): Promise<ElectronApplication> {
  const spcodeHome = mkdtempSync(join(tmpdir(), "spcode-e2e-"));
  const userDataDir = mkdtempSync(join(tmpdir(), "spcode-e2e-userdata-"));
  return electron.launch({
    args: [".", "--no-sandbox", `--user-data-dir=${userDataDir}`],
    cwd: appDir,
    // playwright 的 env 是整体替换而非合并，必须带上 process.env
    env: { ...process.env, SPCODE_HOME: spcodeHome },
  });
}
