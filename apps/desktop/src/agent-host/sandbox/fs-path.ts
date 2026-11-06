import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** 与 pi resolveToCwd 同口径的路径归一：去 @ 前缀、~ 展开、相对 cwd 解析、NFC 归一。 */
export function resolveFsPath(cwd: string, rawPath: string): string {
  let p = rawPath.trim();
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") p = homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = resolve(homedir(), p.slice(2));
  return (isAbsolute(p) ? resolve(p) : resolve(cwd, p)).normalize("NFC");
}
