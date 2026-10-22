/**
 * 会话注册表：~/.spcode/sessions.json
 * 记录每个会话的元信息与 pi 会话文件路径，支撑跨重启的会话列表与恢复。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionRegistryEntry } from "@spcode/shared";
import { isDefaultSessionTitle } from "@spcode/shared/i18n";
import { readJsonFile, resolveSpcodeHome, writeJsonFileAtomic } from "@spcode/shared/node";

// 类型已下沉 shared（评审 R3-C12：渲染层/远程端同一份事实源）；本文件保留 re-export 兼容
export type { SessionRegistryEntry } from "@spcode/shared";

/** 注册表条目的最低结构要求：关键字段类型正确即收，其余字段宽进（老版本新增字段不挡路） */
function validateEntries(data: unknown): SessionRegistryEntry[] | null {
  if (!Array.isArray(data)) return null;
  for (const e of data) {
    if (!e || typeof e !== "object") return null;
    const r = e as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.title !== "string") return null;
    if (r.mode !== "chat" && r.mode !== "project") return null;
    if (typeof r.cwd !== "string" || typeof r.createdAt !== "number" || typeof r.updatedAt !== "number") return null;
  }
  return data as SessionRegistryEntry[];
}

export class SessionRegistry {
  private readonly file: string;
  private entries: SessionRegistryEntry[] | null = null;

  constructor(baseDir?: string) {
    const dir = baseDir ?? resolveSpcodeHome();
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "sessions.json");
  }

  list(): SessionRegistryEntry[] {
    if (this.entries) return this.entries;
    // 结构校验：坏文件先备份 .corrupt-<ts> 再按空表重建，不再静默清空（评审 P2-4）
    this.entries = (readJsonFile(this.file, validateEntries) ?? []).map((entry) => ({
      ...entry,
      titleKind: entry.titleKind ?? (isDefaultSessionTitle(entry) ? "default" : "custom"),
    }));
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
    this.upsert({
      ...cur,
      ...patch,
      ...(patch.title !== undefined && patch.titleKind === undefined ? { titleKind: "custom" as const } : {}),
      id,
      updatedAt: Date.now(),
    });
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
    writeJsonFileAtomic(this.file, this.entries);
  }
}
