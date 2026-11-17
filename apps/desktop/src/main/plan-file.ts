import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveSpcodeHome } from "@spcode/shared/node";

/**
 * 只允许 ~/.spcode/plans 的直接子级 Markdown，拒绝任意路径穿越。
 * 判定后再取一次 realpath：`plans/x.md -> ~/.ssh/id_rsa` 这类符号链接不能靠后缀蒙过校验
 * （评审 R5 P2-2：同目录的普通文件预览已经是 realpath 归一后的口径）。
 */
export function resolveSessionPlanPath(path: string, spcodeHome = resolveSpcodeHome()): string {
  const plansDir = resolve(join(spcodeHome, "plans"));
  const file = resolve(path);
  if (dirname(file) !== plansDir || !file.toLowerCase().endsWith(".md")) {
    throw new Error("Invalid plan file path");
  }
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    // 还没落盘的计划文件保持原路径（读取时自然报错，菜单也不该把它当可执行目标）
    return file;
  }
  const realPlansDir = (() => {
    try {
      return realpathSync(plansDir);
    } catch {
      return plansDir;
    }
  })();
  if (dirname(real) !== realPlansDir) throw new Error("Invalid plan file path");
  return real;
}

/** 只允许读取 plans 目录的直接子级 Markdown。 */
export function readSessionPlan(path: string, spcodeHome = resolveSpcodeHome()): string {
  return readFileSync(resolveSessionPlanPath(path, spcodeHome), "utf-8");
}

/** 计划文件是否存在且是普通文件（右键菜单的动作前提）。 */
export function isExistingPlanFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
