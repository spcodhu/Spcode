/**
 * read/write/edit 的会话级修改契约。
 *
 * pi 0.87.1 的 write 会直接覆盖已有文件，edit 也不要求模型先看过目标。
 * 这里用同一份内容指纹账本补上两条约束：
 * - 已有文件必须先由本会话的 read 成功读取；
 * - 读取后内容发生变化时，必须重新 read，避免基于过期上下文覆写。
 *
 * 每个 createContractFileTools() 调用拥有独立账本：主会话与 Task 子代理互不解锁。
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access as fsAccess,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  realpath as fsRealpath,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  detectSupportedImageMimeTypeFromFile,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { resolveFsPath } from "./fs-path.js";

export type FileContractErrorCode = "FILE_NOT_READ" | "FILE_STALE";

export class FileContractError extends Error {
  constructor(
    readonly code: FileContractErrorCode,
    readonly filePath: string,
  ) {
    super(
      code === "FILE_NOT_READ"
        ? `File ${filePath} has not been read in this session. Use the read tool on this file before modifying it.`
        : `File ${filePath} changed since it was last read. Use the read tool again before modifying it.`,
    );
    this.name = "FileContractError";
  }
}

function fingerprint(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 与文件守卫同口径：存在时取自身 realpath，不存在时归一最近的已存在父目录。 */
async function canonicalPath(filePath: string): Promise<string> {
  const absolute = resolve(filePath);
  try {
    return await fsRealpath(absolute);
  } catch {
    let dir = dirname(absolute);
    for (let i = 0; i < 32; i++) {
      try {
        const realDir = await fsRealpath(dir);
        return resolve(realDir, absolute.slice(dir.length).replace(/^[/\\]+/, ""));
      } catch {
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    return absolute;
  }
}

class FileVersionState {
  private readonly versions = new Map<string, string>();

  async record(filePath: string, content: Buffer | string): Promise<void> {
    this.versions.set(await canonicalPath(filePath), fingerprint(content));
  }

  /** 已存在文件必须读过且仍是同一内容；Write 可把 ENOENT 当新文件，Edit 不可。 */
  async assertCanModify(filePath: string, allowMissing = true): Promise<void> {
    const canonical = await canonicalPath(filePath);
    let current: Buffer;
    try {
      current = await fsReadFile(canonical);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        if (allowMissing) return;
        throw new FileContractError("FILE_STALE", filePath);
      }
      throw error;
    }
    await this.assertCurrentBuffer(canonical, current);
  }

  /** Edit 已读到当前 Buffer 时直接校验，避免为前置检查再读一次。 */
  async assertCurrentBuffer(filePath: string, current: Buffer): Promise<void> {
    const canonical = await canonicalPath(filePath);
    const known = this.versions.get(canonical);
    if (!known) throw new FileContractError("FILE_NOT_READ", filePath);
    if (known !== fingerprint(current)) throw new FileContractError("FILE_STALE", filePath);
  }
}

const READ_REQUIREMENT =
  "For existing files, a successful read in this session is required before modification. If the file changes after reading, read it again.";

/**
 * 创建共享同一版本账本的 read/write/edit。所有修改断言都在 pi 的同文件队列内复核；
 * Write 另做一次执行前检查，避免未读/过期调用在失败前创建父目录。
 */
export function createContractFileTools(cwd: string): ToolDefinition[] {
  const state = new FileVersionState();

  const readBase = createReadToolDefinition(cwd);
  const read: ToolDefinition = {
    ...readBase,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      let captured: { path: string; content: Buffer } | undefined;
      // 每次调用单独创建 definition，capture 天然按 toolCall 隔离，不受并发 Read 影响。
      const scoped = createReadToolDefinition(cwd, {
        operations: {
          access: (path) => fsAccess(path, constants.R_OK),
          detectImageMimeType: detectSupportedImageMimeTypeFromFile,
          readFile: async (path) => {
            const content = await fsReadFile(path);
            captured = { path, content };
            return content;
          },
        },
      });
      const result = await scoped.execute(toolCallId, params as never, signal, onUpdate, ctx);
      if (captured) await state.record(captured.path, captured.content);
      return result;
    },
  } as ToolDefinition;

  const writeBase = createWriteToolDefinition(cwd, {
    operations: {
      mkdir: async (dir) => {
        await fsMkdir(dir, { recursive: true });
      },
      writeFile: async (path, content) => {
        await state.assertCanModify(path);
        await fsWriteFile(path, content, "utf-8");
        await state.record(path, content);
      },
    },
  });
  const write: ToolDefinition = {
    ...writeBase,
    description: `${writeBase.description} ${READ_REQUIREMENT} New files can be written directly.`,
    promptGuidelines: [...(writeBase.promptGuidelines ?? []), `${READ_REQUIREMENT} New files can be written directly.`],
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const input = params as { path: string };
      // 与 pi 当前会话口径一致；正常 AgentSession 的 ctx.cwd 即创建时的 cwd。
      const effectiveCwd = (ctx as { cwd?: string } | undefined)?.cwd || cwd;
      await state.assertCanModify(resolveFsPath(effectiveCwd, input.path));
      return writeBase.execute(toolCallId, params as never, signal, onUpdate, ctx);
    },
  } as ToolDefinition;

  const editBase = createEditToolDefinition(cwd, {
    operations: {
      access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
      readFile: async (path) => {
        const content = await fsReadFile(path);
        await state.assertCurrentBuffer(path, content);
        return content;
      },
      writeFile: async (path, content) => {
        // 再复核一次，覆盖 readFile → writeFile 之间的外部修改窗口；删除也视为过期。
        await state.assertCanModify(path, false);
        await fsWriteFile(path, content, "utf-8");
        await state.record(path, content);
      },
    },
  });
  const edit: ToolDefinition = {
    ...editBase,
    description: `${editBase.description} ${READ_REQUIREMENT}`,
    promptGuidelines: [...(editBase.promptGuidelines ?? []), READ_REQUIREMENT],
  } as ToolDefinition;

  return [read, write, edit];
}
