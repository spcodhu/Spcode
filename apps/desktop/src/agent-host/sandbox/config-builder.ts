/**
 * 沙盒配置构建：会话 cwd + SPCODE_HOME + 用户设置 → sandbox-runtime 配置。
 *
 * 关键设计：
 * - 写权限是 allow-only：cwd、系统临时目录、开发工具缓存（精确到 store 子目录，
 *   不放开 bin 目录——避免沙盒内投毒 PATH 上的可执行文件）。
 * - $SPCODE_HOME 的保护用「精确枚举」而非整目录 deny：聊天模式的 cwd 是
 *   $SPCODE_HOME/scratch，整目录 deny 会把会话自己的工作目录也锁死。
 * - ~/.ssh 等凭据目录禁读；$SPCODE_HOME/agent/auth.json（供应商密钥）禁读。
 * - 项目会话 cwd 通常在 $SPCODE_HOME 之外，此时 denyWrite 枚举依旧带上——
 *   allow-only 语义下无害（不在 allowOnly 里的路径本来就不可写），且能兜住
 *   用户在 extraAllowWrite 里误放开了父目录的情况。
 */
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { SandboxSettings } from "@spcode/shared";

/** $SPCODE_HOME 下对沙盒命令禁写的条目（记忆投毒/配置篡改/凭据泄写防线） */
const SPCODE_HOME_DENY_WRITE = [
  "SOUL.md",
  "USER.md",
  "MEMORY.md",
  "sessions.json",
  "settings.json",
  "schedules.json",
  "feishu.json",
  "agent",
  "plans",
  "projects",
  "remote",
  "usage",
];

/** 默认禁读：凭据与密钥（读取即可能经 stdout 外泄到模型上下文/网络） */
function defaultDenyRead(spcodeHome: string): string[] {
  const home = homedir();
  return [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".netrc"),
    join(home, ".config", "gh"),
    join(spcodeHome, "agent", "auth.json"),
    // 评审 R3-C3：settings.json 含飞书 appSecret/搜索 apiKey；remote/ 含配对私钥与推送 VAPID
    join(spcodeHome, "settings.json"),
    join(spcodeHome, "remote"),
  ];
}

/**
 * 默认允许写入的开发工具缓存。注意全部精确到「存储/缓存」子目录，
 * 刻意不含 bin 目录（pnpm global bin、cargo/bin、go/bin 往往在 PATH 上，
 * 沙盒内可写 = 可在沙盒外被用户后续执行，属于逃逸通道）。
 */
function defaultCacheWritePaths(): string[] {
  const home = homedir();
  return [
    // npm
    join(home, ".npm"),
    // pnpm store（不是 ~/.local/share/pnpm 全部——其根目录是 global bin）
    join(home, ".local", "share", "pnpm", "store"),
    join(home, "Library", "pnpm", "store"),
    join(home, ".pnpm-store"),
    // yarn
    join(home, ".yarn"),
    join(home, ".cache", "yarn"),
    join(home, "Library", "Caches", "Yarn"),
    // bun
    join(home, ".bun", "install", "cache"),
    // pip / 通用缓存
    join(home, ".cache"),
    join(home, "Library", "Caches", "pip"),
    // cargo（registry/git 缓存，不含 ~/.cargo/bin）
    join(home, ".cargo", "registry"),
    join(home, ".cargo", "git"),
    // go 模块缓存（~/go/pkg，不含 ~/go/bin）
    join(home, "go", "pkg"),
    // maven / gradle
    join(home, ".m2", "repository"),
    join(home, ".gradle", "caches"),
    join(home, ".gradle", "wrapper"),
  ];
}

/** pathA 是否等于或位于 pathB 之内（不解析符号链接，纯路径判断；大小写随平台语义从简） */
export function isPathInside(pathA: string, pathB: string): boolean {
  const a = resolve(pathA);
  const b = resolve(pathB);
  return a === b || a.startsWith(b + sep);
}

export interface BuildSandboxConfigOptions {
  /** 会话工作目录 */
  cwd: string;
  /** resolveSpcodeHome() 的结果（e2e 的临时 SPCODE_HOME 也经此传入，不得自己再解析） */
  spcodeHome: string;
  settings: SandboxSettings;
}

export function buildSandboxRuntimeConfig(opts: BuildSandboxConfigOptions): SandboxRuntimeConfig {
  const { cwd, spcodeHome, settings } = opts;

  const allowWrite = [resolve(cwd), tmpdir(), ...defaultCacheWritePaths(), ...settings.filesystem.extraAllowWrite];

  // denyWrite 只在可写区域内有意义：项目内 .env 系列 + SPCODE_HOME 敏感项。
  // .env* 同时有 sandbox-runtime 的 mandatoryDenySearchDepth 兜底，这里是显式双保险。
  const denyWrite = [
    join(cwd, ".env"),
    join(cwd, ".env.*"),
    ...SPCODE_HOME_DENY_WRITE.map((entry) => join(spcodeHome, entry)),
    ...settings.filesystem.extraDenyWrite,
  ];

  const denyRead = [...defaultDenyRead(spcodeHome), ...settings.filesystem.extraDenyRead];

  return {
    network: {
      allowedDomains: [...settings.network.allowedDomains],
      deniedDomains: [...settings.network.deniedDomains],
    },
    filesystem: {
      denyRead,
      allowWrite,
      denyWrite,
    },
    // 敏感文件（.env/.pem/key 等）自动禁写搜索深度，保持默认 3 层
    mandatoryDenySearchDepth: 3,
  };
}
