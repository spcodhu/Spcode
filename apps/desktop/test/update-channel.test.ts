import { describe, expect, it } from "vitest";
import { resolveAllowPrerelease } from "@spcode/shared";

/**
 * 更新通道裁决（设置页「接收测试版更新」开关的语义）：
 * 显式设置优先；未设置时跟随当前版本形态（beta 版收 beta，稳定版只收稳定）。
 */
describe("resolveAllowPrerelease 更新通道裁决", () => {
  it("显式设置优先于版本形态", () => {
    expect(resolveAllowPrerelease(true, "0.1.0")).toBe(true); // 稳定版用户主动收 beta
    expect(resolveAllowPrerelease(false, "0.1.0-beta.4")).toBe(false); // beta 用户钉稳定通道
  });

  it("未设置时跟随当前版本形态", () => {
    expect(resolveAllowPrerelease(undefined, "0.1.0-beta.4")).toBe(true);
    expect(resolveAllowPrerelease(null, "0.1.0-alpha.1")).toBe(true);
    expect(resolveAllowPrerelease(undefined, "0.1.0")).toBe(false);
  });

  it("版本号边界：v 前缀与构建元数据不影响判定", () => {
    expect(resolveAllowPrerelease(undefined, "v0.1.0-beta.4")).toBe(true);
    expect(resolveAllowPrerelease(undefined, "0.1.0+build.7")).toBe(false);
    expect(resolveAllowPrerelease(undefined, "1.2.3-rc.1+sha.abc")).toBe(true);
  });
});
