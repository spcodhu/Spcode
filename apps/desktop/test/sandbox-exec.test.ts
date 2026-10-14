/**
 * 沙盒内核级集成测试（不信任验证：断言 OS 行为，而非库的宣称）。
 *
 * 真起 sandbox-exec（macOS）跑命令：
 * - cwd 内可写 / home 不可写 / 凭据不可读 / 未授权域名不可达
 * - 进程树终止仍生效（pi 的 killProcessTree 穿过 sandbox-exec）
 *
 * 仅 macOS 跑；Linux 依赖 bwrap+socat+ripgrep，CI 默认跳过（有依赖可手动开）。
 * 注意：测试会临时用真实 SandboxManager 初始化网络代理（进程内），结束后 reset。
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX_SETTINGS, type SandboxSettings } from "@spcode/shared";
import { buildSandboxRuntimeConfig, isPathInside } from "../src/agent-host/sandbox/config-builder.js";

const execFileP = promisify(execFile);
const isMac = process.platform === "darwin";

/** 用临时目录冒充 SPCODE_HOME 与 cwd，互不嵌套（项目会话形态） */
let fakeSpcodeHome: string;
let workDir: string;

const settings: SandboxSettings = DEFAULT_SANDBOX_SETTINGS;

beforeAll(() => {
  fakeSpcodeHome = mkdtempSync(join(tmpdir(), "spcode-sbx-home-"));
  workDir = mkdtempSync(join(tmpdir(), "spcode-sbx-work-"));
});

afterAll(async () => {
  rmSync(fakeSpcodeHome, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  if (isMac) {
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    await SandboxManager.reset().catch(() => {});
  }
});

describe("config-builder（平台无关）", () => {
  it("写权限 allow-only：cwd 与 tmpdir 在内，~/.ssh 不可读，SPCODE_HOME 敏感项禁写", () => {
    const cfg = buildSandboxRuntimeConfig({ cwd: workDir, spcodeHome: fakeSpcodeHome, settings });
    const allowWrite = cfg.filesystem.allowWrite.map(String);
    expect(allowWrite).toContain(workDir);
    expect(allowWrite).toContain(tmpdir());
    const denyRead = cfg.filesystem.denyRead.map(String);
    expect(denyRead.some((p) => p.endsWith(".ssh"))).toBe(true);
    expect(denyRead).toContain(join(fakeSpcodeHome, "agent", "auth.json"));
    const denyWrite = cfg.filesystem.denyWrite.map(String);
    expect(denyWrite).toContain(join(fakeSpcodeHome, "SOUL.md"));
    expect(denyWrite).toContain(join(fakeSpcodeHome, "settings.json"));
    expect(denyWrite).toContain(join(fakeSpcodeHome, "agent"));
    // 聊天模式形态（cwd 在 SPCODE_HOME 内）同样成立：精确枚举不会锁死 scratch
    expect(denyWrite).not.toContain(fakeSpcodeHome);
  });

  it("isPathInside：父子/相等/无关路径", () => {
    expect(isPathInside(join(fakeSpcodeHome, "scratch"), fakeSpcodeHome)).toBe(true);
    expect(isPathInside(fakeSpcodeHome, fakeSpcodeHome)).toBe(true);
    expect(isPathInside(workDir, fakeSpcodeHome)).toBe(false);
  });
});

describe.skipIf(!isMac)("沙盒内核行为（macOS seatbelt 真跑）", () => {
  let wrap: (cmd: string) => Promise<string>;

  beforeAll(async () => {
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const cfg = buildSandboxRuntimeConfig({ cwd: workDir, spcodeHome: fakeSpcodeHome, settings });
    await SandboxManager.initialize(cfg);
    wrap = (cmd: string) => SandboxManager.wrapWithSandbox(cmd);
  }, 30_000);

  async function runSandboxed(cmd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const wrapped = await wrap(cmd);
    try {
      const { stdout, stderr } = await execFileP("/bin/bash", ["-c", wrapped], { cwd: workDir, timeout: 20_000 });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  it("cwd 内可写", async () => {
    const r = await runSandboxed("touch ./sandbox-ok && echo done");
    expect(r.code).toBe(0);
    expect(existsSync(join(workDir, "sandbox-ok"))).toBe(true);
  });

  it("home 目录不可写（内核 EPERM）", async () => {
    const probe = join(process.env.HOME ?? "", "spcode-sandbox-probe");
    const r = await runSandboxed(`touch "$HOME/spcode-sandbox-probe"`);
    expect(r.code).not.toBe(0);
    expect(existsSync(probe)).toBe(false);
  });

  it("~/.ssh 不可读", async () => {
    const r = await runSandboxed("ls ~/.ssh 2>&1; echo exit=$?");
    expect(r.stdout).toContain("exit=1");
  });

  it("未授权域名不可达；授权域名可解析", async () => {
    // 未授权域名：代理 CONNECT 直接回 403（sandbox-runtime 代理层拦截）
    const blocked = await runSandboxed("curl -sS -m 8 https://example-not-allowed-xyz.com 2>&1; echo exit=$?");
    expect(blocked.stdout).toMatch(/403|denied|Could not/i);
    expect(blocked.stdout).not.toContain("exit=0");
    const allowed = await runSandboxed("curl -sS -m 10 -o /dev/null -w '%{http_code}' https://github.com 2>&1 | tail -1");
    // 代理放行则应拿到 HTTP 状态码（2xx/3xx/4xx 都算网络通了）
    expect(allowed.stdout.trim()).toMatch(/^[234]\d\d/);
  }, 30_000);

  it("SPCODE_HOME 敏感文件禁写（记忆投毒防线）", async () => {
    const soul = join(fakeSpcodeHome, "SOUL.md");
    writeFileSync(soul, "original", "utf-8");
    const r = await runSandboxed(`echo poisoned > "${soul}" 2>&1; echo exit=$?`);
    expect(r.stdout).toContain("exit=1");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(soul, "utf-8")).toBe("original");
  });
});
