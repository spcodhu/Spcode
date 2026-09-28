/**
 * 会话注册表：~/.spcode/sessions.json
 * 记录每个会话的元信息与 pi 会话文件路径，支撑跨重启的会话列表与恢复。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SPCODE_HOME_DIRNAME, type ModelRef, type SessionMode } from "@spcode/shared";

export interface SessionRegistryEntry {
  id: string;
  mode: SessionMode;
  cwd: string;
  title: string;
  model: ModelRef | null;
  thinkingLevel: string;
  /** pi 会话文件路径（用于恢复），创建后回填 */
  sessionFile: string | null;
  createdAt: number;
  updatedAt: number;
}

export class SessionRegistry {
  private readonly file: string;
  private entries: SessionRegistryEntry[] | null = null;

  constructor(baseDir?: string) {
    const dir = baseDir ?? join(homedir(), SPCODE_HOME_DIRNAME);
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "sessions.json");
  }

  list(): SessionRegistryEntry[] {
    if (this.entries) return this.entries;
    if (!existsSync(this.file)) {
      this.entries = [];
      return this.entries;
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf-8")) as unknown;
      this.entries = Array.isArray(raw) ? (raw as SessionRegistryEntry[]) : [];
    } catch {
      this.entries = [];
    }
    return this.entries;
  }

  get(id: string): SessionRegistryEntry | undefined {
    return this.list().find((e) => e.id === id);
  }

  upsert(entry: SessionRegistryEntry): void {
    const list = this.list();
    const idx = list.findIndex((e) => e.id === entry.id);
    if (idx >= 0) list[idx] = entry;
    else list.unshift(entry);
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    this.persist();
  }

  patch(id: string, patch: Partial<SessionRegistryEntry>): void {
    const cur = this.get(id);
    if (!cur) return;
    this.upsert({ ...cur, ...patch, id, updatedAt: Date.now() });
  }

  remove(id: string): void {
    const list = this.list();
    const idx = list.findIndex((e) => e.id === id);
    if (idx >= 0) {
      list.splice(idx, 1);
      this.persist();
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.entries, null, 2), "utf-8");
    renameSync(tmp, this.file);
  }
}
