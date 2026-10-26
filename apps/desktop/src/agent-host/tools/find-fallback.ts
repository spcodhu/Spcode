/**
 * fd 的离线回退：会话创建时检测一次；fd 不存在时使用系统 find 语义相近的 Node 实现。
 * 保留 basename/full-path glob、隐藏文件、.gitignore、绝对路径与结果上限。
 */
import { spawnSync } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createFindToolDefinition, type FindOperations, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import ignore from "ignore";
import { minimatch } from "minimatch";

interface IgnoreRuleSet {
  dir: string;
  matcher: ignore.Ignore;
}

function isFdAvailable(pathEnv?: string): boolean {
  try {
    const result = spawnSync(process.platform === "win32" ? "where" : "which", ["fd"], {
      stdio: "ignore",
      timeout: 1000,
      env: pathEnv ? { ...process.env, PATH: pathEnv } : process.env,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

async function appendIgnoreFile(dir: string, rules: IgnoreRuleSet[]): Promise<void> {
  try {
    const content = await readFile(join(dir, ".gitignore"), "utf-8");
    rules.push({ dir, matcher: ignore({ ignoreCase: process.platform === "win32" }).add(content) });
  } catch {
    // 没有 .gitignore 或不可读时，沿用父目录规则。
  }
}

async function parentIgnoreRules(searchPath: string): Promise<IgnoreRuleSet[]> {
  const ancestors: string[] = [];
  for (let current = dirname(searchPath); ; current = dirname(current)) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) break;
  }
  const rules: IgnoreRuleSet[] = [];
  for (const dir of ancestors.reverse()) await appendIgnoreFile(dir, rules);
  return rules;
}

function isIgnored(candidate: string, rules: IgnoreRuleSet[], directory: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    const rel = relative(rule.dir, candidate);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    const result = rule.matcher.test(rel + (directory ? "/" : ""));
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return ignored;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function matches(candidate: string, name: string, pattern: string, searchPath: string): boolean {
  const options = { dot: true, nocase: process.platform === "win32" };
  if (isAbsolute(pattern)) return minimatch(toPosix(candidate), toPosix(pattern), options);
  if (pattern.includes("/")) {
    const effective = pattern.startsWith("**/") || pattern === "**" ? pattern : `**/${pattern}`;
    return minimatch(toPosix(relative(searchPath, candidate)), effective, options);
  }
  return minimatch(name, pattern, options);
}

async function globWithNode(pattern: string, searchPath: string, options: { ignore: string[]; limit: number }): Promise<string[]> {
  const root = resolve(searchPath);
  const results: string[] = [];
  const parentRules = await parentIgnoreRules(root);

  async function walk(dir: string, inherited: IgnoreRuleSet[]): Promise<void> {
    if (results.length >= options.limit) return;
    const rules = [...inherited];
    await appendIgnoreFile(dir, rules);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= options.limit) return;
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      const directory = entry.isDirectory();
      const relativePath = toPosix(relative(root, full));
      if (options.ignore.some((pattern) => minimatch(relativePath, pattern, { dot: true }))) continue;
      if (isIgnored(full, rules, directory)) continue;
      if (matches(full, entry.name, pattern, root)) results.push(full);
      if (directory && !entry.isSymbolicLink()) await walk(full, rules);
    }
  }

  await walk(root, parentRules);
  return results.slice(0, options.limit);
}

export function createFindToolWithFallback(cwd: string, pathEnv?: string): ToolDefinition {
  if (isFdAvailable(pathEnv)) return createFindToolDefinition(cwd) as unknown as ToolDefinition;
  const operations: FindOperations = {
    exists: async (absolutePath) => {
      try {
        await access(absolutePath);
        return true;
      } catch {
        return false;
      }
    },
    glob: (pattern, searchPath, options) => globWithNode(pattern, searchPath, options),
  };
  return createFindToolDefinition(cwd, { operations }) as unknown as ToolDefinition;
}
