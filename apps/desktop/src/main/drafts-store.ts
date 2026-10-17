/**
 * 输入框草稿存储：~/.spcode/composer-drafts.json，原子写入（tmp + rename）。
 * key：正式会话 = sessionId；未落盘新会话 = "draft:<mode>:<cwd>"（稳定 key，
 * 重启 App 后点加号仍命中）。渲染层全量读写 + 防抖保存，主进程无缓存。
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ComposerDraft } from "@spcode/shared";
import { readJsonFile, resolveSpcodeHome } from "@spcode/shared/node";

/** 字段级宽松：只校验顶层是 map；单条草稿缺字段由渲染层读取时兜底 */
function validateDrafts(data: unknown): Record<string, ComposerDraft> | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data as Record<string, ComposerDraft>;
}

export class DraftsStore {
  private readonly file: string;

  constructor(baseDir?: string) {
    this.file = join(baseDir ?? resolveSpcodeHome(), "composer-drafts.json");
  }

  get(): Record<string, ComposerDraft> {
    return readJsonFile(this.file, validateDrafts) ?? {};
  }

  set(drafts: Record<string, ComposerDraft>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(drafts), "utf-8");
    renameSync(tmp, this.file);
  }
}
