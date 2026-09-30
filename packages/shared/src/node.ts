/**
 * Node 侧专用助手（渲染进程勿导入——依赖 node:os/node:path）。
 * 经 @spcode/shared/node 子路径导出，与纯类型/纯函数的主入口隔离。
 *
 * 注意：主进程构建走 externalizeDepsPlugin，本文件在运行时以 TS 源码形式被
 * Node 直接加载，相对引用 ./index.js 会解析失败——因此不得 import 主入口，
 * 下方目录名必须与 index.ts 的 SPCODE_HOME_DIRNAME 保持一致
 *（一致性由 test/spcode-home.test.ts 锁定）。
 */

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 数据根目录名：与 index.ts 的 SPCODE_HOME_DIRNAME 同值 */
const HOME_DIRNAME = ".spcode";

/**
 * 数据根目录：优先 SPCODE_HOME 环境变量（e2e/测试隔离、toB 自定义数据位置），
 * 缺省 ~/.spcode。main 与 agent-host 必须统一走这里，不得再各自 homedir() 拼接。
 */
export function resolveSpcodeHome(): string {
  const override = process.env.SPCODE_HOME?.trim();
  return override || join(homedir(), HOME_DIRNAME);
}

/**
 * 读 JSON 数据文件并做结构校验（评审 P2-4）：
 * - 文件不存在 → null（首跑常态，调用方按空数据走）
 * - JSON 解析失败 / 校验不通过 → 先把坏文件原样备份为 <file>.corrupt-<ts>，再返回 null
 *   （调用方随后按空数据重建并覆盖写，备份保证原内容不被静默吞掉）
 */
export function readJsonFile<T>(file: string, validate: (data: unknown) => T | null): T | null {
  if (!existsSync(file)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    backupCorruptFile(file);
    return null;
  }
  const result = validate(data);
  if (result === null) backupCorruptFile(file);
  return result;
}

function backupCorruptFile(file: string): void {
  try {
    copyFileSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    // 备份失败不阻塞主流程（权限/磁盘满等场景下次读取还会再试）
  }
}
