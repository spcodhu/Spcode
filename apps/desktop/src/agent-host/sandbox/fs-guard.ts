/**
 * 文件工具路径守卫（评审 R3-C3）：pi 内置 read/write/edit/grep/find/ls 走进程内 fs，
 * 不在 OS 沙盒边界内——这里是它们的边界。
 *
 * 三层判定（judgeFsToolCall）：
 * - deny：凭据/密钥硬拒绝（无弹窗），与 bash 沙盒 denyRead 同源——
 *   `read ~/.ssh/id_ed25519` 这类路径在任何模式下都不该发生；
 * - prompt：高敏路径转权限弹窗（danger 级，任何权限模式都弹）：
 *   ~/.spcode 应用数据目录（记忆/设置/注册表/导出）、写出工作区（cwd 之外且不在 extraAllowWrite）；
 * - allow：其余（含 cwd 内一切、cwd 外的普通读取）。
 *
 * 判定在两层生效（纵深防御）：
 * 1. beforeToolCall 网关（session-controller）：deny 直接拦，prompt 弹窗，可解释原因；
 * 2. 工具 definition 包装（本文件 createGuardedFsTools）：deny 硬兜底——网关漏判/未来重构
 *    也不致裸奔。Task 子代理注册同一套守卫工具（R3-C4），边界同源。
 *
 * 符号链接：路径存在时经 realpath 再判一次（cwd 内的链接指向 ~/.ssh 不能逃逸）；
 * 不存在时（写新文件）对最近已存在的父目录取 realpath。
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { isPathInside } from "./config-builder.js";

export interface FsGuardPolicy {
  /** 会话工作目录（项目目录或 chat 的 scratch） */
  cwd: string;
  /** ~/.spcode 数据目录 */
  spcodeHome: string;
  /** 额外禁读（设置页 sandbox.filesystem.extraDenyRead，与 bash 沙盒同清单） */
  extraDenyRead: string[];
  /** 额外允许写入（设置页 sandbox.filesystem.extraAllowWrite） */
  extraAllowWrite: string[];
}

export type FsVerdict = { action: "allow" } | { action: "deny"; reason: string } | { action: "prompt"; reason: string };

/** 凭据/密钥硬拒清单（读写皆拒；与 config-builder 的 defaultDenyRead 同语义来源） */
function hardDenyPaths(policy: FsGuardPolicy): string[] {
  const home = homedir();
  return [
    ...[
      join3(home, ".ssh"),
      join3(home, ".aws"),
      join3(home, ".gnupg"),
      join3(home, ".netrc"),
      join3(home, ".config", "gh"),
      join3(policy.spcodeHome, "agent", "auth.json"),
      join3(policy.spcodeHome, "remote"),
    ],
    ...policy.extraDenyRead,
  ];
}

function join3(...parts: string[]): string {
  return resolve(...parts);
}

/** 与 pi resolveToCwd 同口径的路径归一：去 @ 前缀、~ 展开、相对 cwd 解析、NFC 归一 */
export function resolveFsPath(cwd: string, rawPath: string): string {
  let p = rawPath.trim();
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") p = homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = join3(homedir(), p.slice(2));
  return (isAbsolute(p) ? resolve(p) : resolve(cwd, p)).normalize("NFC");
}

/** 符号链接真实路径：存在取自身 realpath，不存在取最近存在父目录的 realpath 再拼回 */
function realpathOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    let dir = dirname(p);
    // 向上找第一个存在的祖先
    for (let i = 0; i < 32; i++) {
      try {
        const realDir = realpathSync(dir);
        return resolve(realDir, p.slice(dir.length).replace(/^[/\\]+/, ""));
      } catch {
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    return p;
  }
}

/** 判断单个路径（op=read/write）。verdict 语义见文件头注释 */
export function judgeFsPath(policy: FsGuardPolicy, op: "read" | "write", rawPath: string): FsVerdict {
  const p = realpathOf(resolveFsPath(policy.cwd, rawPath));
  // cwd / spcodeHome 也要过 realpath：macOS 上 /var 与 /private/var 是同一目录的两种写法，
  // 不归一会把 cwd 内文件误判为「工作区外」（真实踩坑）
  const cwd = realpathOf(policy.cwd);
  const spcodeHome = realpathOf(policy.spcodeHome);

  // 1) 凭据/密钥：读写一律硬拒（无弹窗——这类路径没有任何正当 agent 用途）
  for (const d of hardDenyPaths(policy)) {
    const realD = realpathOf(d);
    if (p === realD || isPathInside(p, realD)) {
      return { action: "deny", reason: `路径 ${d} 属于凭据/密钥保护区，一律禁止访问（设置页无法放开）` };
    }
  }

  // 2) cwd 内：放行（含 chat 的 scratch 目录）
  if (p === cwd || isPathInside(p, cwd)) return { action: "allow" };

  // 3) ~/.spcode 数据目录（记忆/设置/注册表/导出件）：读写都弹窗（danger 级——写记忆=持久投毒面）
  if (p === spcodeHome || isPathInside(p, spcodeHome)) {
    return {
      action: "prompt",
      reason: `目标在应用数据目录（~/.spcode）内：含记忆/设置/会话注册表/配对密钥，${op === "write" ? "写入" : "读取"}需要用户明确批准`,
    };
  }

  // 4) 写出工作区：弹窗（extraAllowWrite 白名单除外）
  if (op === "write") {
    for (const w of policy.extraAllowWrite) {
      const realW = realpathOf(resolve(w));
      if (p === realW || isPathInside(p, realW)) return { action: "allow" };
    }
    return { action: "prompt", reason: "目标在工作目录之外（写入工作区外需要用户明确批准）" };
  }

  // 5) cwd 外的普通读取：放行（凭据区已在第 1 步拦掉）
  return { action: "allow" };
}

/** 带 path 参数的文件类工具 → 操作类型；非文件工具返回 null */
const FS_TOOL_OPS: Record<string, "read" | "write"> = {
  read: "read",
  grep: "read",
  find: "read",
  ls: "read",
  write: "write",
  edit: "write",
};

/**
 * 判定一次工具调用的路径合法性。返回 null = 非文件类工具（调用方走正常流程）。
 * args.path 缺省视为 cwd（列目录等场景）。
 */
export function judgeFsToolCall(toolName: string, args: unknown, policy: FsGuardPolicy): FsVerdict | null {
  const op = FS_TOOL_OPS[toolName.toLowerCase()];
  if (!op) return null;
  const raw =
    args && typeof args === "object" && "path" in args && typeof (args as { path?: unknown }).path === "string"
      ? ((args as { path: string }).path as string)
      : policy.cwd;
  return judgeFsPath(policy, op, raw);
}

/** 工具结果形态的拒绝文本（包装层用，与 pi 工具错误返回同构） */
function denyResult(reason: string): { content: { type: "text"; text: string }[]; isError: true } {
  return {
    content: [{ type: "text", text: `Blocked by Spcode path policy: ${reason}` }],
    isError: true,
  };
}

/** 单工具包装：deny 在执行前硬拦（不调原实现），allow/prompt 放行（prompt 由网关层处理） */
function wrapFsTool(def: ToolDefinition, getPolicy: () => FsGuardPolicy): ToolDefinition {
  return {
    ...def,
    execute: (toolCallId: string, params: never, signal: AbortSignal | undefined, onUpdate: never, ctx: never) => {
      const verdict = judgeFsToolCall(def.name, params, getPolicy());
      if (verdict?.action === "deny") return Promise.resolve(denyResult(verdict.reason) as never);
      return def.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  } as ToolDefinition;
}

/**
 * read/write/edit 的守卫版本（同名覆盖 pi 内置，customTools 注册语义）。
 * grep/find/ls 只在网关层判定（它们的路径是搜索根，敏感性低一档，硬兜底收益小）。
 */
export function createGuardedFsTools(cwd: string, getPolicy: () => FsGuardPolicy): ToolDefinition[] {
  return [
    wrapFsTool(createReadToolDefinition(cwd) as ToolDefinition, getPolicy),
    wrapFsTool(createWriteToolDefinition(cwd) as ToolDefinition, getPolicy),
    wrapFsTool(createEditToolDefinition(cwd) as ToolDefinition, getPolicy),
  ];
}
