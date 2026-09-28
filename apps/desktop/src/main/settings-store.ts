/**
 * 应用设置存储：~/.spcode/settings.json，原子写入。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, SPCODE_HOME_DIRNAME, type AppSettings } from "@spcode/shared";

export class SettingsStore {
  readonly dir: string;
  private readonly file: string;
  private cache: AppSettings | null = null;

  constructor(baseDir?: string) {
    this.dir = baseDir ?? join(homedir(), SPCODE_HOME_DIRNAME);
    this.file = join(this.dir, "settings.json");
  }

  get(): AppSettings {
    if (this.cache) return this.cache;
    let loaded: Partial<AppSettings> = {};
    if (existsSync(this.file)) {
      try {
        loaded = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<AppSettings>;
      } catch {
        loaded = {};
      }
    }
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
