import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readWorkspaceFile, WorkspaceFileError } from "../src/main/workspace-file.js";

let root = "";
let cwd = "";
let home = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "spcode-workspace-file-"));
  cwd = join(root, "project");
  home = join(root, "home");
  mkdirSync(join(cwd, "nested"), { recursive: true });
  mkdirSync(join(home, "agent"), { recursive: true });
  mkdirSync(join(home, "scratch"), { recursive: true });
  writeFileSync(join(cwd, "foo.ts"), "export const foo = 1;\n", "utf-8");
  writeFileSync(join(home, "scratch", "chat.txt"), "chat scratch file\n", "utf-8");
  writeFileSync(join(cwd, "nested", "bar.md"), "# bar\n", "utf-8");
  writeFileSync(join(home, "agent", "auth.json"), "{}", "utf-8");
  writeFileSync(join(root, "outside.txt"), "secret outside cwd", "utf-8");
  writeFileSync(join(cwd, "huge.txt"), "x".repeat(2 * 1024 * 1024 + 1), "utf-8");
  writeFileSync(join(cwd, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 5]));
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("工作区文件预览读取边界", () => {
  it("读取 cwd 内的相对/绝对路径文件", () => {
    // macOS 上 /tmp 是 /private/tmp 的符号链接，返回值经 realpath 归一后与原始拼接路径不一定字面相等
    expect(readWorkspaceFile("foo.ts", cwd, home)).toEqual({
      path: realpathSync(join(cwd, "foo.ts")),
      text: "export const foo = 1;\n",
    });
    expect(readWorkspaceFile(join(cwd, "nested", "bar.md"), cwd, home).text).toBe("# bar\n");
    expect(readWorkspaceFile("@foo.ts", cwd, home).text).toBe("export const foo = 1;\n");
  });

  it("拒绝 cwd 之外的路径（含目录穿越）", () => {
    expect(() => readWorkspaceFile(join(cwd, "..", "outside.txt"), cwd, home)).toThrow(WorkspaceFileError);
    expect(() => readWorkspaceFile("/etc/hosts", cwd, home)).toThrow(WorkspaceFileError);
    try {
      readWorkspaceFile(join(cwd, "..", "outside.txt"), cwd, home);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(WorkspaceFileError);
      expect((e as WorkspaceFileError).code).toBe("outside-workspace");
    }
  });

  it("cwd 为空时映射到 chat 的 scratch，仍禁止越出该目录", () => {
    expect(readWorkspaceFile("chat.txt", "", home).text).toBe("chat scratch file\n");
    try {
      readWorkspaceFile("../outside.txt", "", home);
      expect.unreachable();
    } catch (e) {
      expect((e as WorkspaceFileError).code).toBe("outside-workspace");
    }
  });

  it("即使 cwd 恰好指向凭据目录也硬拒绝", () => {
    try {
      readWorkspaceFile("auth.json", join(home, "agent"), home);
      expect.unreachable();
    } catch (e) {
      expect((e as WorkspaceFileError).code).toBe("denied");
    }
  });

  it("文件不存在 / 超大 / 二进制分别给出对应错误码", () => {
    const notFound = (() => {
      try {
        readWorkspaceFile("missing.ts", cwd, home);
      } catch (e) {
        return e as WorkspaceFileError;
      }
      return undefined;
    })();
    expect(notFound?.code).toBe("not-found");

    const tooLarge = (() => {
      try {
        readWorkspaceFile("huge.txt", cwd, home);
      } catch (e) {
        return e as WorkspaceFileError;
      }
      return undefined;
    })();
    expect(tooLarge?.code).toBe("too-large");

    const binary = (() => {
      try {
        readWorkspaceFile("bin.dat", cwd, home);
      } catch (e) {
        return e as WorkspaceFileError;
      }
      return undefined;
    })();
    expect(binary?.code).toBe("binary");
  });

  it.runIf(process.platform !== "win32")("符号链接真实路径逃出 cwd 时拒绝", () => {
    const link = join(cwd, "escape-link.txt");
    symlinkSync(join(root, "outside.txt"), link);
    try {
      readWorkspaceFile("escape-link.txt", cwd, home);
      expect.unreachable();
    } catch (e) {
      expect((e as WorkspaceFileError).code).toBe("outside-workspace");
    }
  });
});
