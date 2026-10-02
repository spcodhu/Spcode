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
  // playwright 的 env 是整体替换而非合并，必须带上 process.env
  const env = { ...process.env, SPCODE_HOME: spcodeHome };
  // 防御：在 Electron 系宿主终端（如 Kimi 桌面 runtime node）里跑 e2e 时，
  // 父进程会被注入 ELECTRON_RUN_AS_NODE=1，透传后 Electron 会以纯 Node 启动
  // （"does not provide an export named 'BrowserWindow'"），launch 前剔除。
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({
    args: [".", "--no-sandbox", `--user-data-dir=${userDataDir}`],
    cwd: appDir,
    env,
  });
}
