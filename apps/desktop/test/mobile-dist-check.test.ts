import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error 纯 Node ESM 脚本没有类型声明；测试直接覆盖其真实 CLI 共用实现
import { validateMobileDist } from "../scripts/check-mobile-dist.mjs";

const dirs: string[] = [];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "spcode-mobile-dist-check-"));
  dirs.push(dir);
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    '<link rel="manifest" href="./manifest.webmanifest"><script src="./assets/index-A.js"></script><link rel="stylesheet" href="./assets/index-A.css">',
  );
  writeFileSync(join(dir, "manifest.webmanifest"), "{}");
  writeFileSync(join(dir, "sw.js"), "// sw");
  writeFileSync(join(dir, "assets/index-A.js"), "// entry");
  writeFileSync(join(dir, "assets/index-A.css"), "body{}");
  writeFileSync(join(dir, "assets/qr-scanner-worker.min-A.js"), "// worker");
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("手机 PWA 打包前完整性校验", () => {
  it("接受入口、HTML 引用和扫码 worker 完整的构建", () => {
    expect(validateMobileDist(fixture())).toBe(3);
  });

  it("拒绝缺少 index.html 的空构建", () => {
    const dir = fixture();
    rmSync(join(dir, "index.html"));
    expect(() => validateMobileDist(dir)).toThrow(/index\.html/);
  });

  it("拒绝 index.html 引用了但磁盘不存在的哈希资源", () => {
    const dir = fixture();
    rmSync(join(dir, "assets/index-A.js"));
    expect(() => validateMobileDist(dir)).toThrow(/index-A\.js/);
  });

  it("拒绝缺少扫码 worker 的构建", () => {
    const dir = fixture();
    rmSync(join(dir, "assets/qr-scanner-worker.min-A.js"));
    expect(() => validateMobileDist(dir)).toThrow(/qr-scanner worker/);
  });
});
