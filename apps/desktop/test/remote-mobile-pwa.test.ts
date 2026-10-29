import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMobilePwaBuilt, resolveMobileDistDir } from "../src/main/remote/mobile-pwa.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spcode-mobile-pwa-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("手机 PWA 资源定位", () => {
  it("开发环境固定解析 appPath 同级的 apps/mobile/dist，并以 index.html 判断可用性", () => {
    const root = tempDir();
    const appPath = join(root, "apps/desktop");
    const dist = join(root, "apps/mobile/dist");
    const runtime = { appPath, resourcesPath: join(root, "unused-resources"), isPackaged: false };

    expect(resolveMobileDistDir(undefined, runtime)).toBe(dist);
    expect(isMobilePwaBuilt(dist)).toBe(false);

    mkdirSync(dist, { recursive: true });
    expect(isMobilePwaBuilt(dist)).toBe(false); // 空目录不能误判为已构建
    writeFileSync(join(dist, "index.html"), "<!doctype html>");
    expect(isMobilePwaBuilt(dist)).toBe(true);
  });

  it("安装版固定使用 process.resourcesPath/mobile，不退回源码目录", () => {
    const root = tempDir();
    const resourcesPath = join(root, "Spcod.app/Contents/Resources");
    const expected = join(resourcesPath, "mobile");
    const runtime = { appPath: join(resourcesPath, "app.asar"), resourcesPath, isPackaged: true };

    expect(resolveMobileDistDir(undefined, runtime)).toBe(expected);
    mkdirSync(expected, { recursive: true });
    writeFileSync(join(expected, "index.html"), "<!doctype html>");
    expect(isMobilePwaBuilt(resolveMobileDistDir(undefined, runtime))).toBe(true);
  });

  it("显式覆盖优先于环境变量，便于开发和诊断", () => {
    const root = tempDir();
    vi.stubEnv("SPCODE_MOBILE_DIST", join(root, "from-env"));
    const runtime = { appPath: join(root, "apps/desktop"), resourcesPath: "", isPackaged: false };

    expect(resolveMobileDistDir(join(root, "explicit"), runtime)).toBe(join(root, "explicit"));
    expect(resolveMobileDistDir(undefined, runtime)).toBe(join(root, "from-env"));
  });
});
