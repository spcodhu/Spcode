/**
 * Node 侧专用助手（渲染进程勿导入——依赖 node:os/node:path）。
 * 经 @spcode/shared/node 子路径导出，与纯类型/纯函数的主入口隔离。
 *
 * 注意：主进程构建走 externalizeDepsPlugin，本文件在运行时以 TS 源码形式被
 * Node 直接加载，相对引用 ./index.js 会解析失败——因此不得 import 主入口，
 * 下方目录名必须与 index.ts 的 SPCODE_HOME_DIRNAME 保持一致
 *（一致性由 test/spcode-home.test.ts 锁定）。
 */
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
