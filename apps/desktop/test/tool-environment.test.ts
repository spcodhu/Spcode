import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandboxedBashTool } from "../src/agent-host/sandbox/bash-tool.js";
import { createSessionToolEnvironment } from "../src/agent-host/tool-environment.js";

let root = "";
let home = "";
let temp = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "spcode-tool-env-"));
  home = join(root, "home");
  temp = join(root, "tmp");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function installNvm(version: string): string {
  const bin = join(home, ".nvm", "versions", "node", version, "bin");
  mkdirSync(bin, { recursive: true });
  return bin;
}

describe("createSessionToolEnvironment", () => {
  it("保留继承 PATH 优先级，补 nvm 默认版本并确保临时目录存在", () => {
    const nvmBin = installNvm("v22.22.2");
    mkdirSync(join(home, ".nvm", "alias"), { recursive: true });
    writeFileSync(join(home, ".nvm", "alias", "default"), "v22.22.2\n", "utf-8");

    const env = createSessionToolEnvironment({ env: { PATH: "/usr/bin:/bin" }, homeDir: home, tmpdir: temp });
    const entries = env.path.split(delimiter);
    expect(entries.slice(0, 2)).toEqual(["/usr/bin", "/bin"]);
    expect(entries).toContain(nvmBin);
    expect(entries.filter((entry) => entry === nvmBin)).toHaveLength(1);
    expect(statSync(env.tmpdir).isDirectory()).toBe(true);

    const context = env.spawnHook({ command: "git status", cwd: root, env: { PATH: "/usr/bin", PI_SESSION_ID: "s1" } });
    expect(context.env.PI_SESSION_ID).toBe("s1");
    expect(context.env[env.pathKey]).toBe(env.path);
    expect(context.env.TMPDIR).toBe(temp);
    expect(context.env.CI).toBeUndefined();
  });

  it("没有 default alias 时选择最新已安装 Node 版本", () => {
    installNvm("v22.20.0");
    const latest = installNvm("v22.22.2");
    const env = createSessionToolEnvironment({ env: { PATH: "/usr/bin" }, homeDir: home, tmpdir: temp });
    expect(env.path.split(delimiter)).toContain(latest);
  });

  it("仅包管理器生命周期命令补 CI=1，且保留显式 CI", () => {
    const env = createSessionToolEnvironment({ env: { PATH: "/usr/bin" }, homeDir: home, tmpdir: temp });
    for (const command of ["pnpm install", "npm ci", "yarn add pkg", "bun update", "pnpm patch-commit /tmp/patch"]) {
      const context = env.spawnHook({ command, cwd: root, env: {} });
      expect(context.env.CI, command).toBe("1");
    }
    for (const command of ["pnpm test", "pnpm typecheck", "git commit -m x"]) {
      const context = env.spawnHook({ command, cwd: root, env: {} });
      expect(context.env.CI, command).toBeUndefined();
    }
    const explicit = env.spawnHook({ command: "pnpm install", cwd: root, env: { CI: "0" } });
    expect(explicit.env.CI).toBe("0");
  });
});

describe("createSandboxedBashTool（sandboxEnabled=false）", () => {
  it("沙盒关闭时也经 spawnHook 使用同一份会话环境", async () => {
    const nvmBin = installNvm("v22.22.2");
    const environment = createSessionToolEnvironment({ env: { PATH: "/usr/bin" }, homeDir: home, tmpdir: temp });
    const tool = createSandboxedBashTool(root, { allowBypass: false, sandboxEnabled: false, environment });
    expect(tool.description).not.toContain("OS-enforced sandbox");
    expect(tool.executionMode).toBe("parallel");
    expect(tool.promptGuidelines?.some((line) => line.includes("same tool-call batch"))).toBe(true);

    const result = await tool.execute(
      "t1",
      { command: "printf '%s' \"$PATH\"" },
      undefined,
      undefined as never,
      undefined as never,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content?.[0]?.text).toContain(nvmBin);
  });
});
