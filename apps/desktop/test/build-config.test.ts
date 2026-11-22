import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");

describe("桌面打包品牌与 Windows 升级兼容", () => {
  it("显示品牌使用 Spcode，Windows 主程序保留旧 Spcod.exe 路径", () => {
    expect(config).toMatch(/^productName: Spcode$/m);
    expect(config).toMatch(/^win:\n(?: {2}.*\n)*? {2}executableName: Spcod$/m);
  });
});
