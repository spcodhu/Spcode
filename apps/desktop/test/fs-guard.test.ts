/**
 * 文件工具路径守卫单测（评审 R3-C3）：
 * 判定矩阵（cwd 内/外、~/.spcode、凭据区、extraAllowWrite、~/相对/@ 前缀、符号链接逃逸）
 * 与工具包装层（deny 硬拦、allow 透传）。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createGuardedFsTools,
  type FsGuardPolicy,
  judgeFsPath,
  judgeFsToolCall,
  resolveFsPath,
} from "../src/agent-host/sandbox/fs-guard.js";

let root = "";
let cwd = "";
let spcodeHome = "";
let policy: FsGuardPolicy;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "spcode-fsguard-"));
  cwd = join(root, "project");
  spcodeHome = join(root, ".spcode");
  policy = { cwd, spcodeHome, extraDenyRead: [], extraAllowWrite: [] };
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("resolveFsPath", () => {
  it("相对路径按 cwd 解析；@ 前缀剥离；~ 展开到 home；NFC 归一", () => {
    expect(resolveFsPath(cwd, "src/a.ts")).toBe(join(cwd, "src/a.ts"));
    expect(resolveFsPath(cwd, "@src/a.ts")).toBe(join(cwd, "src/a.ts"));
    expect(resolveFsPath(cwd, "~/x")).toBe(join(homedir(), "x"));
    // 绝对路径预期值按平台算：Windows 上 "/abs/./y/../z" 是「当前盘符的根」→ D:\abs\z
    expect(resolveFsPath(cwd, "/abs/./y/../z")).toBe(resolve("/abs/z"));
  });
});

describe("judgeFsPath 判定矩阵", () => {
  it("cwd 内读写都放行", () => {
    expect(judgeFsPath(policy, "read", "src/a.ts").action).toBe("allow");
    expect(judgeFsPath(policy, "write", "src/a.ts").action).toBe("allow");
    expect(judgeFsPath(policy, "write", cwd).action).toBe("allow");
  });

  it("凭据区硬拒（读写皆拒、无弹窗）", () => {
    for (const p of [
      "~/.ssh/id_ed25519",
      "~/.aws/credentials",
      "~/.gnupg/pubring.kbx",
      "~/.netrc",
      "~/.config/gh/hosts.yml",
    ]) {
      expect(judgeFsPath(policy, "read", p).action).toBe("deny");
      expect(judgeFsPath(policy, "write", p).action).toBe("deny");
    }
    expect(judgeFsPath(policy, "read", join(spcodeHome, "agent", "auth.json")).action).toBe("deny");
    expect(judgeFsPath(policy, "read", join(spcodeHome, "remote", "device.key")).action).toBe("deny");
  });

  it("~/.spcode 数据目录（非 cwd 部分）：读写都 prompt", () => {
    expect(judgeFsPath(policy, "write", join(spcodeHome, "MEMORY.md")).action).toBe("prompt");
    expect(judgeFsPath(policy, "read", join(spcodeHome, "settings.json")).action).toBe("prompt");
    expect(judgeFsPath(policy, "read", join(spcodeHome, "exports", "x", "transcript.md")).action).toBe("prompt");
  });

  it("chat 模式 cwd = ~/.spcode/scratch 时不误伤：scratch 内放行", () => {
    const chatPolicy: FsGuardPolicy = { ...policy, cwd: join(spcodeHome, "scratch") };
    expect(judgeFsPath(chatPolicy, "write", join(spcodeHome, "scratch", "a.txt")).action).toBe("allow");
    expect(judgeFsPath(chatPolicy, "read", join(spcodeHome, "MEMORY.md")).action).toBe("prompt");
  });

  it("cwd 外普通路径：读放行、写 prompt；extraAllowWrite 内写放行", () => {
    expect(judgeFsPath(policy, "read", "/etc/hosts").action).toBe("allow");
    expect(judgeFsPath(policy, "write", "/etc/hosts").action).toBe("prompt");
    const allowed: FsGuardPolicy = { ...policy, extraAllowWrite: [join(root, "allowed")] };
    expect(judgeFsPath(allowed, "write", join(root, "allowed", "a.txt")).action).toBe("allow");
  });

  it("符号链接逃逸：cwd 内链接指向硬拒目录按真实路径硬拒", () => {
    // 用 policy 自己的硬拒目录（~/.spcode/remote 存配对密钥）做靶子，不依赖
    // 开发机/CI 上 ~/.ssh 是否存在——旧写法在干净 Windows runner 上指向不存在的目录，
    // realpath 落空后退化成「cwd 内路径」直接放行，测试假红（真实安全语义未受影响）。
    const denyTarget = join(spcodeHome, "remote");
    mkdirSync(denyTarget, { recursive: true });
    const link = join(cwd, "escape-link");
    mkdirSync(cwd, { recursive: true });
    rmSync(link, { recursive: true, force: true });
    // Windows 建目录符号链接需要开发者模式/管理员；junction 无需特权，语义同为目录链接
    symlinkSync(denyTarget, link, process.platform === "win32" ? "junction" : "dir");
    expect(judgeFsPath(policy, "read", join(link, "device.key")).action).toBe("deny");
  });

  it("extraDenyRead 生效", () => {
    const p2: FsGuardPolicy = { ...policy, extraDenyRead: [join(root, "secret-dir")] };
    expect(judgeFsPath(p2, "read", join(root, "secret-dir", "x")).action).toBe("deny");
  });
});

describe("judgeFsToolCall", () => {
  it("非文件工具返回 null；read/write/edit/grep/find/ls 按 path 判定；path 缺省按 cwd 放行", () => {
    expect(judgeFsToolCall("bash", { command: "ls" }, policy)).toBeNull();
    expect(judgeFsToolCall("read", { path: "~/.ssh/id_ed25519" }, policy)?.action).toBe("deny");
    expect(judgeFsToolCall("write", { path: join(cwd, "a.ts"), content: "x" }, policy)?.action).toBe("allow");
    expect(judgeFsToolCall("edit", { path: join(spcodeHome, "MEMORY.md"), edits: [] }, policy)?.action).toBe("prompt");
    expect(judgeFsToolCall("grep", { pattern: "x", path: "~/.aws" }, policy)?.action).toBe("deny");
    expect(judgeFsToolCall("ls", {}, policy)?.action).toBe("allow");
  });
});

describe("守卫工具包装层", () => {
  it("deny 路径在执行前硬拦（不调原实现）；cwd 内正常读", async () => {
    const tools = createGuardedFsTools(cwd, () => policy);
    const read = tools.find((t) => t.name === "read")!;
    // deny：直接返回错误结果，不抛异常、不读文件
    const denied = (await read.execute(
      "t1",
      { path: "~/.ssh/id_ed25519" } as never,
      undefined,
      undefined as never,
      {} as never,
    )) as { isError?: boolean; content: { text: string }[] };
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain("path policy");

    // allow：真实读 cwd 内文件
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "hello.txt"), "hello-guard");
    const ok = (await read.execute(
      "t2",
      { path: "hello.txt" } as never,
      undefined,
      undefined as never,
      {} as never,
    )) as { content: { text?: string }[] };
    expect(JSON.stringify(ok.content)).toContain("hello-guard");
  });
});
