/**
 * 应用设置存储：~/.spcode/settings.json，原子写入。
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AppSettings, DEFAULT_SETTINGS } from "@spcode/shared";
import { readJsonFile, resolveSpcodeHome } from "@spcode/shared/node";

/** 设置文件只需是普通对象（字段级宽松：合并到 DEFAULT_SETTINGS 之上，未知/多余字段原样保留） */
function validateSettings(data: unknown): Partial<AppSettings> | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data as Partial<AppSettings>;
}

export class SettingsStore {
  readonly dir: string;
  private readonly file: string;
  private cache: AppSettings | null = null;

  constructor(baseDir?: string) {
    this.dir = baseDir ?? resolveSpcodeHome();
    this.file = join(this.dir, "settings.json");
  }

  get(): AppSettings {
    if (this.cache) return this.cache;
    // 坏文件先备份 .corrupt-<ts> 再回退默认设置，不再静默吞掉（评审 P2-4）
    const loaded = readJsonFile(this.file, validateSettings) ?? {};
    this.cache = { ...DEFAULT_SETTINGS, ...loaded };
    return this.cache;
  }

  set(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.get(), ...patch };
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8");
    renameSync(tmp, this.file);
    this.cache = next;
    return next;
  }
}
