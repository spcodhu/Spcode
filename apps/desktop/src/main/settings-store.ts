/**
 * 应用设置存储：~/.spcode/settings.json，原子写入 + 0600（含飞书 appSecret/搜索 apiKey）。
 * 评审 R3-C8：
 * - 字段级 sanitize（fail-safe）：非法 permissionMode 回落默认 ask（坏值会让 write 全放行）；
 * - getSettings 对渲染层脱敏（主进程 index.ts 的 redactSettingsForRenderer），写回时掩码还原。
 */
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { type AppSettings, DEFAULT_SETTINGS, SECRET_MASK, sanitizeCompactionSettings } from "@spcode/shared";
import { resolveLocale } from "@spcode/shared/i18n";
import { readJsonFile, resolveSpcodeHome, writeJsonFileAtomic } from "@spcode/shared/node";

/** 设置文件只需是普通对象（字段级宽松：合并到 DEFAULT_SETTINGS 之上，未知/多余字段原样保留） */
function validateSettings(data: unknown): Partial<AppSettings> | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data as Partial<AppSettings>;
}

/**
 * 字段级 sanitize（fail-safe，评审 R3-C8）：类型不符的安全关键字段直接剔除（回落默认），
 * 绝不带病合并——permissionMode 落个怪值会让 write 级操作全静默放行。
 */
export function sanitizeAppSettings(input: Partial<AppSettings>): Partial<AppSettings> {
  const out = { ...input };
  if ("locale" in out) out.locale = resolveLocale(out.locale);
  // 枚举：非法值剔除（合并时回落默认 ask）
  if (out.permissionMode !== undefined && out.permissionMode !== "ask" && out.permissionMode !== "act") {
    delete out.permissionMode;
  }
  // 布尔字段
  for (const k of ["memoryDistill", "quickQuota", "autoUpdate", "betaUpdates"] as const) {
    if (out[k] !== undefined && typeof out[k] !== "boolean") delete out[k];
  }
  // 字符串字段
  for (const k of [
    "defaultThinkingLevel",
    "themeId",
    "uiFontFamily",
    "monoFontFamily",
    "uiFontFile",
    "monoFontFile",
    "ignoredUpdateVersion",
  ] as const) {
    if (out[k] !== undefined && typeof out[k] !== "string") delete out[k];
  }
  // 字符串数组字段
  for (const k of ["disabledProviders", "disabledModels", "permissionRules"] as const) {
    const v = out[k];
    if (v === undefined) continue;
    if (!Array.isArray(v)) {
      delete out[k];
      continue;
    }
    out[k] = v.filter((x): x is string => typeof x === "string") as never;
  }
  // 嵌套对象字段必须是普通对象（数组/标量剔除，交给 get() 的归一化补默认）
  for (const k of ["remote", "sandbox", "advancedSearch", "defaultModel", "customTheme", "compaction"] as const) {
    const v = out[k];
    if (v !== undefined && v !== null && (typeof v !== "object" || Array.isArray(v))) delete out[k];
  }
  return out;
}

export class SettingsStore {
  readonly dir: string;
  private readonly file: string;
  private cache: AppSettings | null = null;

  constructor(baseDir?: string) {
    this.dir = baseDir ?? resolveSpcodeHome();
    this.file = join(this.dir, "settings.json");
    // 存量文件权限修正（R3-C8：老版本写的是 0644，启动即收紧为 0600）
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // 文件尚不存在 / Windows 无 POSIX 权限位
    }
  }

  get(): AppSettings {
    if (this.cache) return this.cache;
    // 坏文件先备份 .corrupt-<ts> 再回退默认设置，不再静默吞掉（评审 P2-4）
    const loaded = sanitizeAppSettings(readJsonFile(this.file, validateSettings) ?? {});
    // remote 是嵌套对象：浅合并会让旧 settings.json 缺字段时丢默认值，单独归一化
    const loadedRemote =
      loaded.remote && typeof loaded.remote === "object" ? (loaded.remote as Partial<AppSettings["remote"]>) : {};
    // remote.feishu 再嵌套一层，同理归一化（旧配置缺 appSecret 等字段时补默认）
    const loadedFeishu =
      loadedRemote.feishu && typeof loadedRemote.feishu === "object"
        ? (loadedRemote.feishu as Partial<AppSettings["remote"]["feishu"]>)
        : {};
    // sandbox 同理：旧配置缺 sandbox 段或段内缺 network/filesystem 字段时补默认
    const loadedSandbox =
      loaded.sandbox && typeof loaded.sandbox === "object" ? (loaded.sandbox as Partial<AppSettings["sandbox"]>) : {};
    const loadedSandboxNetwork =
      loadedSandbox.network && typeof loadedSandbox.network === "object"
        ? (loadedSandbox.network as Partial<AppSettings["sandbox"]["network"]>)
        : {};
    const loadedSandboxFilesystem =
      loadedSandbox.filesystem && typeof loadedSandbox.filesystem === "object"
        ? (loadedSandbox.filesystem as Partial<AppSettings["sandbox"]["filesystem"]>)
        : {};
    this.cache = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      locale: resolveLocale(loaded.locale),
      remote: {
        ...DEFAULT_SETTINGS.remote,
        ...loadedRemote,
        feishu: { ...DEFAULT_SETTINGS.remote.feishu, ...loadedFeishu },
      },
      sandbox: {
        ...DEFAULT_SETTINGS.sandbox,
        ...loadedSandbox,
        network: { ...DEFAULT_SETTINGS.sandbox.network, ...loadedSandboxNetwork },
        filesystem: { ...DEFAULT_SETTINGS.sandbox.filesystem, ...loadedSandboxFilesystem },
      },
      // compaction：段缺失补默认；段内字段非法时回落出厂值（非法值会让引擎在 agent 循环里 throw）
      compaction: sanitizeCompactionSettings(loaded.compaction),
    };
    return this.cache;
  }

  set(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.get(), ...sanitizeAppSettings(patch) };
    // 同上：写入前归一化，杜绝非法值落到盘上
    if ("compaction" in patch) next.compaction = sanitizeCompactionSettings(patch.compaction);
    writeJsonFileAtomic(this.file, next, { mode: 0o600 });
    this.cache = next;
    return next;
  }
}

/**
 * getSettings 的渲染层脱敏（评审 R3-C8）：密钥字段只回掩码，不回明文。
 * 渲染层原样写回掩码时，setSettings 负责还原成真值（见 restoreMaskedSecrets）。
 */
export function redactSettingsForRenderer(s: AppSettings): AppSettings {
  return {
    ...s,
    advancedSearch: s.advancedSearch
      ? { ...s.advancedSearch, apiKey: s.advancedSearch.apiKey ? SECRET_MASK : "" }
      : null,
    webFetch: s.webFetch ? { ...s.webFetch, apiKey: s.webFetch.apiKey ? SECRET_MASK : "" } : null,
    remote: {
      ...s.remote,
      feishu: { ...s.remote.feishu, appSecret: s.remote.feishu.appSecret ? SECRET_MASK : "" },
    },
  };
}

/** setSettings 的掩码还原：patch 里仍是掩码的密钥字段换回当前存储的真值 */
export function restoreMaskedSecrets(patch: Partial<AppSettings>, current: AppSettings): Partial<AppSettings> {
  const out = { ...patch };
  if (out.advancedSearch && out.advancedSearch.apiKey === SECRET_MASK) {
    out.advancedSearch = { ...out.advancedSearch, apiKey: current.advancedSearch?.apiKey ?? "" };
  }
  if (out.webFetch && out.webFetch.apiKey === SECRET_MASK) {
    out.webFetch = { ...out.webFetch, apiKey: current.webFetch?.apiKey ?? "" };
  }
  if (out.remote?.feishu && out.remote.feishu.appSecret === SECRET_MASK) {
    out.remote = { ...out.remote, feishu: { ...out.remote.feishu, appSecret: current.remote.feishu.appSecret } };
  }
  return out;
}
