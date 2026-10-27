import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveSpcodeHome } from "@spcode/shared/node";

/** 只允许读取 ~/.spcode/plans 的直接子级 Markdown，拒绝任意路径穿越。 */
export function readSessionPlan(path: string, spcodeHome = resolveSpcodeHome()): string {
  const plansDir = resolve(join(spcodeHome, "plans"));
  const file = resolve(path);
  if (dirname(file) !== plansDir || !file.toLowerCase().endsWith(".md")) {
    throw new Error("Invalid plan file path");
  }
  return readFileSync(file, "utf-8");
}
