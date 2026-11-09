/**
 * 工作区文件预览读取（右侧工作区面板用）。
 *
 * 场景：消息流里的工具调用（read/write/edit）带着模型操作过的文件路径，
 * 用户点一下就想在右侧看内容——但点击是零摩擦动作，不能因此打开一个
 * 任意路径读取通道。这里的边界只服务预览，比 agent-host 的 fs-guard 更紧：
 * - 只认会话自己的工作目录（项目 cwd；chat 会话为空 cwd 时映射到 ~/.spcode/scratch），
 *   不认 extraAllowWrite/沙盒例外；
 * - 凭据/密钥目录硬拒绝（与 fs-guard 同源清单，防御纵深：即便调用方传错 cwd 也不会读到）；
 * - 文本与位图分开读取：文本拒绝二进制；图片校验扩展名、真实签名与大小后转为 base64。
 *
 * 不复用 plan-file.ts 的 readSessionPlan：职责不同（固定子目录 vs 会话 cwd），
 * 合并只会让两条边界的判定逻辑互相牵扯。
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { resolveSpcodeHome } from "@spcode/shared/node";
import { decodeImageAttachment, MAX_IMAGE_BYTES } from "./image-file.js";

/** 预览文件大小上限：超出不读内容（避免把巨文件塞进渲染进程/Shiki 高亮卡死） */
export const WORKSPACE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

export type WorkspaceFileErrorCode = "outside-workspace" | "denied" | "not-found" | "too-large" | "binary";

export class WorkspaceFileError extends Error {
  constructor(
    readonly code: WorkspaceFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceFileError";
  }
}

/** 路径存在时取自身 realpath；不存在则向上找最近已存在的祖先目录再拼回（与 fs-guard 同策略） */
function realpathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    let dir = dirname(path);
    for (let i = 0; i < 32; i++) {
      try {
        const realDir = realpathSync(dir);
        return resolve(realDir, path.slice(dir.length).replace(/^[/\\]+/, ""));
      } catch {
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    return path;
  }
}

function isInside(path: string, dir: string): boolean {
  const caseInsensitive = process.platform === "win32";
  const norm = (p: string): string => {
    const abs = resolve(p);
    const trimmed = abs.length > 1 && abs.endsWith(sep) ? abs.slice(0, -1) : abs;
    return caseInsensitive ? trimmed.toLowerCase() : trimmed;
  };
  const a = norm(path);
  const b = norm(dir);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/** 凭据/密钥硬拒清单：与 agent-host 的 fs-guard.hardDenyPaths 同源语义 */
function hardDenyDirs(spcodeHome: string): string[] {
  const home = homedir();
  return [
    resolve(home, ".ssh"),
    resolve(home, ".aws"),
    resolve(home, ".gnupg"),
    resolve(home, ".netrc"),
    resolve(home, ".config", "gh"),
    resolve(spcodeHome, "agent", "auth.json"),
    resolve(spcodeHome, "remote"),
  ];
}

/** 简单二进制探测：采样头部字节找空字节，避免把文本预览当成图片/字体渲染 */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

/** 与 agent-host 文件工具一致：接受相对/绝对路径、@ 前缀与 ~ 展开。 */
function resolveInputPath(workspaceRoot: string, rawPath: string): string {
  let path = rawPath.trim();
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~") path = homedir();
  else if (path.startsWith("~/") || path.startsWith("~\\")) path = resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path);
}

/** 把输入路径限制在会话 cwd/scratch 内，并返回符号链接归一后的真实路径。 */
function resolveGuardedPath(rawPath: string, workspaceRoot: string, realHome: string, displayPath = rawPath): string {
  const absolute = resolveInputPath(workspaceRoot, rawPath);
  const real = realpathOf(absolute);
  const realCwd = realpathOf(workspaceRoot);

  for (const deny of hardDenyDirs(realHome)) {
    const realDeny = realpathOf(deny);
    if (real === realDeny || isInside(real, realDeny)) {
      throw new WorkspaceFileError("denied", `Path ${displayPath} is protected and cannot be previewed.`);
    }
  }
  if (!(real === realCwd || isInside(real, realCwd))) {
    throw new WorkspaceFileError("outside-workspace", `Path ${displayPath} is outside the session workspace.`);
  }
  return real;
}

/**
 * 相对图片路径以 Markdown 文档所在目录为基准，而不是会话 cwd。
 * documentPath 本身也必须通过同一工作区守卫，不能借它把图片解析到cwd之外。
 */
function resolvePreviewPath(rawPath: string, cwd: string, spcodeHome: string, documentPath?: string): string {
  const trimmedCwd = cwd.trim();
  const workspaceRoot = trimmedCwd || resolve(spcodeHome, "scratch");
  const realHome = realpathOf(resolve(spcodeHome));
  if (!documentPath) return resolveGuardedPath(rawPath, workspaceRoot, realHome);
  const documentReal = resolveGuardedPath(documentPath, workspaceRoot, realHome);
  const absolute = resolveInputPath(dirname(documentReal), rawPath);
  return resolveGuardedPath(absolute, workspaceRoot, realHome, rawPath);
}

function readPreviewBytes(real: string, rawPath: string, maxBytes: number): Buffer {
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(real);
  } catch {
    throw new WorkspaceFileError("not-found", `File not found: ${rawPath}`);
  }
  if (!info.isFile()) throw new WorkspaceFileError("not-found", `Not a file: ${rawPath}`);
  if (info.size > maxBytes) {
    throw new WorkspaceFileError("too-large", `File is too large to preview: ${rawPath}`);
  }
  return readFileSync(real);
}

/**
 * 读取会话工作目录内的文件用于预览。
 * project 模式 cwd 是 session.meta.cwd；chat 模式渲染层只知道空 cwd，
 * 这里按与 SessionController 相同的规则映射到 ~/.spcode/scratch。
 */
export function readWorkspaceFile(
  rawPath: string,
  cwd: string,
  spcodeHome = resolveSpcodeHome(),
): { path: string; text: string } {
  const real = resolvePreviewPath(rawPath, cwd, spcodeHome);
  const buffer = readPreviewBytes(real, rawPath, WORKSPACE_PREVIEW_MAX_BYTES);
  if (looksBinary(buffer)) {
    throw new WorkspaceFileError("binary", `Binary files can't be previewed as text: ${rawPath}`);
  }
  return { path: real, text: buffer.toString("utf-8") };
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** Markdown 内本地图片预览：只在工作区内读取真实位图，渲染进程不获得任意 file:// 加载能力。 */
export function readWorkspaceImage(
  rawPath: string,
  cwd: string,
  documentPath?: string,
  spcodeHome = resolveSpcodeHome(),
): { path: string; mimeType: string; data: string } {
  const real = resolvePreviewPath(rawPath, cwd, spcodeHome, documentPath);
  const buffer = readPreviewBytes(real, rawPath, MAX_IMAGE_BYTES);
  const mimeType = IMAGE_MIME_BY_EXTENSION[extname(real).toLowerCase()];
  if (!mimeType) throw new WorkspaceFileError("binary", `Unsupported image format: ${rawPath}`);
  try {
    const decoded = decodeImageAttachment({ name: basename(real), mimeType, data: buffer.toString("base64") });
    return { path: real, mimeType: decoded.mimeType, data: decoded.bytes.toString("base64") };
  } catch {
    throw new WorkspaceFileError("binary", `Invalid image file: ${rawPath}`);
  }
}
