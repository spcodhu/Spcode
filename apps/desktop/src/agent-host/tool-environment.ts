/**
 * 会话级 Bash 环境：每个 SessionController/Task 创建时解析一次，后续经 spawnHook 复用。
 *
 * 设计约束：
 * - 不启动 login shell、不读取 shell rc，避免初始化副作用与交互等待；
 * - 保留继承 PATH 的优先级，只在末尾补充存在的常见工具目录；
 * - 临时目录在会话创建时确保存在，避免首条命令才失败；
 * - 仅包管理器生命周期命令补 CI=1，不全局改变测试/构建行为。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir as osTmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { BashSpawnHook } from "@earendil-works/pi-coding-agent";

export interface SessionToolEnvironment {
  pathKey: string;
  path: string;
  tmpdir: string;
  spawnHook: BashSpawnHook;
}

export interface CreateSessionToolEnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  tmpdir?: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function compareNodeVersions(a: string, b: string): number {
  const pa = a.slice(1).split(".").map(Number);
  const pb = b.slice(1).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function resolveNvmBin(env: NodeJS.ProcessEnv, homeDir: string): string | undefined {
  const nvmDir = env.NVM_DIR?.trim() || join(homeDir, ".nvm");
  const candidates: string[] = [];
  if (env.NVM_BIN?.trim()) candidates.push(env.NVM_BIN.trim());
  candidates.push(join(nvmDir, "current", "bin"));

  const aliasFile = join(nvmDir, "alias", "default");
  if (existsSync(aliasFile)) {
    try {
      const alias = readFileSync(aliasFile, "utf-8").trim();
      if (/^v\d+\.\d+\.\d+$/.test(alias)) candidates.push(join(nvmDir, "versions", "node", alias, "bin"));
    } catch {
      // 读取失败时继续尝试已安装版本目录。
    }
  }

  const versionsDir = join(nvmDir, "versions", "node");
  if (isDirectory(versionsDir)) {
    const versions = readdirSync(versionsDir)
      .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
      .sort(compareNodeVersions);
    if (versions[0]) candidates.push(join(versionsDir, versions[0], "bin"));
  }
  return candidates.find(isDirectory);
}

function resolvePath(env: NodeJS.ProcessEnv, homeDir: string): { pathKey: string; path: string } {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const entries = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
  const candidates = [
    resolveNvmBin(env, homeDir),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homeDir, ".volta", "bin"),
    join(homeDir, ".asdf", "shims"),
    join(homeDir, ".local", "bin"),
    join(homeDir, ".cargo", "bin"),
    join(homeDir, "Library", "pnpm"),
    join(homeDir, ".local", "share", "pnpm"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);

  for (const candidate of candidates) {
    if (isDirectory(candidate) && !entries.includes(candidate)) entries.push(candidate);
  }
  return { pathKey, path: entries.join(delimiter) };
}

function resolveTmpdir(env: NodeJS.ProcessEnv, override?: string): string {
  if (override) return override;
  if (process.platform === "win32") return env.TMPDIR || env.TEMP || env.TMP || osTmpdir();
  // 与 sandbox-runtime 的 TMPDIR 生成规则一致；hook 同时覆盖沙盒外路径。
  return env.CLAUDE_CODE_TMPDIR || env.CLAUDE_TMPDIR || "/tmp/claude";
}

function isPackageManagerLifecycleCommand(command: string): boolean {
  return /^\s*(?:pnpm|npm|yarn|bun)\s+(?:i|install|ci|add|remove|uninstall|update|upgrade|rebuild|link|unlink|patch|patch-commit)\b/i.test(
    command,
  );
}

export function createSessionToolEnvironment(opts: CreateSessionToolEnvironmentOptions = {}): SessionToolEnvironment {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const { pathKey, path } = resolvePath(env, homeDir);
  const tmpdir = resolveTmpdir(env, opts.tmpdir);
  mkdirSync(tmpdir, { recursive: true });

  const spawnHook: BashSpawnHook = (context) => {
    const nextEnv = { ...context.env, [pathKey]: path, TMPDIR: tmpdir };
    if (isPackageManagerLifecycleCommand(context.command) && !nextEnv.CI) nextEnv.CI = "1";
    return { ...context, env: nextEnv };
  };
  return { pathKey, path, tmpdir, spawnHook };
}
